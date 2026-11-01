import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

import type { App } from 'electron';

import {
  restartEnvironment,
  restartPeerVariable,
  type LaunchSpec,
  type RestartReply,
  type RestartRequest,
} from './restart-protocol.js';

export interface AutoRestart {
  setEnabled(enabled: boolean): Promise<void>;
  prepareNormalExit(): Promise<void>;
}

type RestartApp = Pick<App, 'isPackaged' | 'getAppPath' | 'getPath'>;
type Peer = ChildProcess | NodeJS.Process;
type Connection = (
  | { kind: 'owned-child'; peer: ChildProcess }
  | { kind: 'inherited-peer'; peer: NodeJS.Process }
) & {
  closed: Promise<void>;
  exited: Promise<void>;
  stop?: Promise<void>;
};
type State =
  | { phase: 'off' }
  | { phase: 'starting' | 'armed' | 'stopping'; connection: Connection };

const handshakeTimeoutMs = 2000;

export function restoreRestartProfile(app: Pick<App, 'setPath'>): boolean {
  const userData = restartProfile();
  if (!userData) return false;
  app.setPath('userData', userData);
  return true;
}

function restartProfile(): string | undefined {
  const value = process.env[restartPeerVariable];
  return value && isAbsolute(value) ? value : undefined;
}

function inheritedUserData(): string | undefined {
  return process.connected && process.send ? restartProfile() : undefined;
}

function launchSpec(app: RestartApp): LaunchSpec {
  const cwd = process.cwd();
  const arguments_ = process.argv.slice(1);
  if (!app.isPackaged) {
    const entry = arguments_[0];
    if (entry && !entry.startsWith('-')) arguments_[0] = resolve(cwd, entry);
    else arguments_.unshift(app.getAppPath());
  }
  return {
    execPath: process.execPath,
    args: arguments_,
    cwd,
    userData: app.getPath('userData'),
  };
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('自动重启辅助进程未在限定时间内响应。')),
      handshakeTimeoutMs,
    );
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function createAutoRestart(
  app: RestartApp,
  moduleDirectory: string,
  onFailure: (error: Error) => void = () => {},
): AutoRestart {
  let state: State = { phase: 'off' };
  let serial = Promise.resolve();
  let exiting = false;
  let normalExit: Promise<void> | undefined;

  const current = () => (state.phase === 'off' ? undefined : state.connection);

  function connect(kind: Connection['kind'], peer: Peer): Connection {
    let close!: () => void;
    let exit!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const connection = { kind, peer, closed, exited } as Connection;
    const departed = () => {
      close();
      if (kind === 'inherited-peer') exit();
      if (current() !== connection) return;
      const wasArmed = state.phase === 'armed';
      state = { phase: 'off' };
      if (wasArmed && !exiting)
        onFailure(new Error('自动重启辅助进程已断开，异常恢复已关闭。'));
    };
    peer.once('disconnect', departed);
    const ended = () => {
      exit();
      departed();
    };
    peer.once('exit', ended);
    if (kind === 'owned-child') peer.once('close', ended);
    peer.on('error', () => {});
    if (!peer.connected) departed();
    return connection;
  }

  if (inheritedUserData()) {
    state = {
      phase: 'starting',
      connection: connect('inherited-peer', process),
    };
  }

  async function exchange(
    connection: Connection,
    request: RestartRequest,
    expected: RestartReply['type'],
  ): Promise<void> {
    const peer = connection.peer;
    let receive!: (message: unknown) => void;
    let fail!: (error?: Error) => void;
    const reply = new Promise<void>((resolve, reject) => {
      receive = (message) => {
        if (
          current() === connection &&
          message &&
          typeof message === 'object' &&
          (message as RestartReply).type === expected
        )
          resolve();
      };
      fail = (error) => reject(error ?? new Error('自动重启辅助进程已断开。'));
      peer.on('message', receive);
      peer.once('disconnect', fail);
      peer.once('exit', fail);
      peer.once('error', fail);
      if (!peer.connected || !peer.send) fail();
      else {
        try {
          peer.send(request, undefined, undefined, (error: Error | null) => {
            if (error) fail(error);
          });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    try {
      await withTimeout(reply);
    } finally {
      peer.removeListener('message', receive);
      peer.removeListener('disconnect', fail);
      peer.removeListener('exit', fail);
      peer.removeListener('error', fail);
    }
  }

  function stop(connection: Connection): Promise<void> {
    if (connection.stop) return connection.stop;
    if (current() === connection) state = { phase: 'stopping', connection };
    connection.stop = (async () => {
      try {
        await exchange(connection, { type: 'stop' }, 'stopped');
        await withTimeout(Promise.all([connection.closed, connection.exited]));
      } catch (error) {
        if (connection.kind === 'owned-child') {
          if (
            connection.peer.exitCode === null &&
            connection.peer.signalCode === null
          )
            connection.peer.kill();
          await withTimeout(connection.exited);
        }
        throw error;
      } finally {
        delete connection.stop;
      }
      if (current() === connection) state = { phase: 'off' };
    })();
    return connection.stop;
  }

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const result = serial.then(operation);
    serial = result.catch(() => {});
    return result;
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    return enqueue(async () => {
      if (enabled && exiting)
        throw new Error('应用正在退出，不能启用自动重启。');
      if (!enabled) {
        const connection = current();
        if (connection) await stop(connection);
        return;
      }
      if (
        state.phase === 'stopping' &&
        state.connection.kind === 'inherited-peer'
      )
        throw new Error('自动重启辅助进程停止尚未确认，不能重新启用。');
      if (state.phase === 'armed') return;
      let connection = current();
      if (!connection) {
        const options: ForkOptions & { windowsHide: boolean } = {
          execPath: process.execPath,
          execArgv: [],
          detached: true,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: {
            ...restartEnvironment(process.env),
            ELECTRON_RUN_AS_NODE: '1',
          },
        };
        const peer = fork(
          join(moduleDirectory, 'restart-supervisor.cjs'),
          [],
          options,
        );
        peer.unref();
        connection = connect('owned-child', peer);
        state = { phase: 'starting', connection };
      }
      try {
        await exchange(
          connection,
          { type: 'arm', launch: launchSpec(app) },
          'armed',
        );
        if (exiting || current() !== connection)
          throw new Error('应用正在退出或辅助进程已断开，不能启用自动重启。');
        state = { phase: 'armed', connection };
      } catch (error) {
        try {
          await stop(connection);
        } catch {
          /* The original enable failure is reported below. */
        }
        throw error;
      }
    });
  }

  function prepareNormalExit(): Promise<void> {
    if (normalExit) return normalExit;
    exiting = true;
    const connection = current();
    const stopping = connection ? stop(connection) : Promise.resolve();
    normalExit = enqueue(() => stopping);
    void stopping.catch(() => {});
    return normalExit;
  }

  return { setEnabled, prepareNormalExit };
}
