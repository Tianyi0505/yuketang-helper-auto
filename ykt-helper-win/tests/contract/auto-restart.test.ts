import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Script } from 'node:vm';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutoRestart } from '../../apps/desktop/main/auto-restart.js';
import * as protocol from '../../apps/desktop/main/restart-protocol.js';

const nextTurn = setImmediate;
const flush = () => new Promise<void>((resolve) => nextTurn(resolve));
const sources = new Map<string, Script>();

function script(name: string): Script {
  let result = sources.get(name);
  if (!result) {
    const source = new URL(
      `../../apps/desktop/main/${name}.ts`,
      import.meta.url,
    );
    result = new Script(
      ts.transpileModule(readFileSync(source, 'utf8'), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      }).outputText,
      { filename: source.pathname },
    );
    sources.set(name, result);
  }
  return result;
}

class Peer extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: string | null = null;
  acknowledgeArm = true;
  acknowledgeStop: 'complete' | 'ack-only' | 'none' = 'complete';
  completeSend = true;
  readonly unref = vi.fn();
  readonly kill = vi.fn(() => {
    this.end(null, 'SIGTERM');
    return true;
  });
  readonly send = vi.fn(
    (message: { type: string }, ...arguments_: unknown[]) => {
      const callback = arguments_.at(-1);
      if (this.completeSend && typeof callback === 'function') callback(null);
      if (message.type === 'arm' && this.acknowledgeArm) {
        queueMicrotask(() => this.emit('message', { type: 'armed' }));
      } else if (message.type === 'stop' && this.acknowledgeStop !== 'none') {
        queueMicrotask(() => {
          this.emit('message', { type: 'stopped' });
          if (this.acknowledgeStop === 'complete') this.end(0);
        });
      }
      return true;
    },
  );
  readonly disconnect = vi.fn(() => {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnect');
  });

  end(code: number | null, signal: string | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.disconnect();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function evaluate(
  name: string,
  process: unknown,
  childProcess: Record<string, unknown>,
) {
  const exports: Record<string, any> = {};
  script(name).runInNewContext({
    exports,
    require: (name: string) => {
      if (name === 'node:child_process') return childProcess;
      if (name === 'node:path') return path;
      if (name === './restart-protocol.js') return protocol;
      throw new Error(`Unexpected restart dependency: ${name}`);
    },
    process,
    setTimeout,
    clearTimeout,
    Date,
  });
  return exports;
}

type ControllerOptions = {
  inherited?: boolean;
  packaged?: boolean;
  argv?: string[];
  environment?: NodeJS.ProcessEnv;
  peer?: () => Peer;
};

function controller(options: ControllerOptions = {}) {
  const peers: Peer[] = [];
  const fork = vi.fn(() => {
    const peer = options.peer?.() ?? new Peer();
    peers.push(peer);
    return peer;
  });
  const process = Object.assign(new Peer(), {
    env: options.environment ?? {},
    argv: options.argv ?? ['/electron', '.', '--', '--debug-profile'],
    execPath: '/electron',
    cwd: () => '/source/desktop',
  });
  process.connected = options.inherited ?? false;
  if (options.inherited)
    process.env[protocol.restartPeerVariable] = '/actual/profile';
  const app = {
    isPackaged: options.packaged ?? false,
    getAppPath: () => '/source/desktop',
    getPath: () => '/actual/profile',
    setPath: vi.fn(),
  };
  const exports = evaluate('auto-restart', process, { fork });
  const failure = vi.fn();
  const restart: AutoRestart = exports.createAutoRestart(
    app,
    '/bundle/main',
    failure,
  );
  return { restart, peers, fork, process, app, failure, exports };
}

function supervisor() {
  const children: Peer[] = [];
  const spawn = vi.fn(() => {
    const child = new Peer();
    children.push(child);
    return child;
  });
  const process = Object.assign(new Peer(), {
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_CHANNEL_FD: '3',
      NODE_CHANNEL_SERIALIZATION_MODE: 'json',
      [protocol.restartPeerVariable]: '/stale/profile',
      SAFE: 'kept',
    },
    exit: vi.fn(),
  });
  process.acknowledgeArm = false;
  process.acknowledgeStop = 'none';
  evaluate('restart-supervisor', process, { spawn });
  const launch = {
    execPath: '/electron',
    args: ['/fixtures/app.cjs', '--', '--portable'],
    cwd: '/fixtures',
    userData: '/actual/profile',
  };
  const arm = () => process.emit('message', { type: 'arm', launch });
  return { children, spawn, process, launch, arm };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('auto restart controller', () => {
  it('does not create a helper while disabled', async () => {
    const test = controller();
    await test.restart.setEnabled(false);
    await test.restart.prepareNormalExit();
    expect(test.fork).not.toHaveBeenCalled();
  });

  it('does not accept send completion as an armed acknowledgement', async () => {
    const test = controller({
      peer: () => Object.assign(new Peer(), { acknowledgeArm: false }),
    });
    let enabled = false;
    const pending = test.restart.setEnabled(true).then(() => {
      enabled = true;
    });
    await flush();
    expect(enabled).toBe(false);
    expect(test.peers[0]!.send.mock.calls[0]![0].type).toBe('arm');
    test.peers[0]!.emit('message', { type: 'armed' });
    await pending;
    expect(enabled).toBe(true);
  });

  it('serializes on/off/on and ignores events from the retired helper', async () => {
    const test = controller();
    await Promise.all([
      test.restart.setEnabled(true),
      test.restart.setEnabled(false),
      test.restart.setEnabled(true),
    ]);
    expect(test.fork).toHaveBeenCalledTimes(2);
    test.peers[0]!.emit('message', { type: 'armed' });
    test.peers[0]!.emit('disconnect');
    test.peers[0]!.emit('exit', 1, null);
    await test.restart.setEnabled(true);
    expect(test.fork).toHaveBeenCalledTimes(2);
    expect(test.failure).not.toHaveBeenCalled();
  });

  it('waits for stopped acknowledgement, closed IPC, and owned helper exit', async () => {
    const test = controller();
    await test.restart.setEnabled(true);
    const peer = test.peers[0]!;
    peer.acknowledgeStop = 'ack-only';
    let disabled = false;
    const pending = test.restart.setEnabled(false).then(() => {
      disabled = true;
    });
    await flush();
    expect(disabled).toBe(false);
    peer.disconnect();
    await flush();
    expect(disabled).toBe(false);
    peer.end(0);
    await pending;
    expect(disabled).toBe(true);
    expect(peer.kill).not.toHaveBeenCalled();
  });

  it('rejects failed enabling and late acknowledgements cannot arm a replacement', async () => {
    let count = 0;
    const test = controller({
      peer: () => {
        const peer = new Peer();
        if (count++ === 0) {
          peer.acknowledgeArm = false;
          peer.acknowledgeStop = 'none';
        }
        return peer;
      },
    });
    const failed = test.restart.setEnabled(true).catch((error: Error) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    expect((await failed).message).toContain('未在限定时间内响应');
    expect(test.peers[0]!.kill).toHaveBeenCalledOnce();
    test.peers[0]!.emit('message', { type: 'armed' });
    await test.restart.setEnabled(true);
    expect(test.fork).toHaveBeenCalledTimes(2);
    await test.restart.setEnabled(false);
  });

  it('rejects missing stop acknowledgement even if the owned helper has exited', async () => {
    const test = controller();
    await test.restart.setEnabled(true);
    const peer = test.peers[0]!;
    peer.acknowledgeStop = 'none';
    const stopped = test.restart
      .setEnabled(false)
      .catch((error: Error) => error);
    await flush();
    peer.end(0);
    expect((await stopped).message).toBe('自动重启辅助进程已断开。');
    expect(peer.kill).not.toHaveBeenCalled();
    await test.restart.setEnabled(true);
    expect(test.fork).toHaveBeenCalledTimes(2);
  });

  it('does not treat stopped acknowledgement alone as confirmed inherited shutdown', async () => {
    const test = controller({ inherited: true });
    await test.restart.setEnabled(true);
    test.process.acknowledgeStop = 'ack-only';
    const stopped = test.restart
      .setEnabled(false)
      .catch((error: Error) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await stopped).message).toContain('未在限定时间内响应');
    expect(test.process.connected).toBe(true);
    expect(test.process.kill).not.toHaveBeenCalled();
    expect(test.process.disconnect).not.toHaveBeenCalled();
  });

  it('can terminate only its owned helper when normal shutdown times out', async () => {
    const test = controller();
    await test.restart.setEnabled(true);
    test.peers[0]!.acknowledgeStop = 'none';
    const stopped = test.restart
      .prepareNormalExit()
      .catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await stopped).message).toContain('未在限定时间内响应');
    expect(test.peers[0]!.kill).toHaveBeenCalledOnce();
    expect(test.process.kill).not.toHaveBeenCalled();
    expect(test.fork).toHaveBeenCalledOnce();
  });

  it('rejects spawn errors without leaving a stale connection', async () => {
    const test = controller();
    test.fork.mockImplementationOnce(() => {
      throw new Error('Missing helper');
    });
    await expect(test.restart.setEnabled(true)).rejects.toThrow(
      'Missing helper',
    );
    await test.restart.setEnabled(true);
    expect(test.peers).toHaveLength(1);
  });

  it('does not create a helper for enabling queued before normal exit', async () => {
    const test = controller();
    const pending = test.restart.setEnabled(true);
    const exited = test.restart.prepareNormalExit();
    await expect(pending).rejects.toThrow('应用正在退出');
    await exited;
    expect(test.fork).not.toHaveBeenCalled();
    await expect(test.restart.setEnabled(true)).rejects.toThrow('应用正在退出');
  });

  it('sends stop synchronously when normal exit interrupts pending enabling', async () => {
    const test = controller({
      peer: () => Object.assign(new Peer(), { acknowledgeArm: false }),
    });
    const pending = test.restart
      .setEnabled(true)
      .catch((error: Error) => error);
    await flush();
    const exited = test.restart.prepareNormalExit();
    expect(
      test.peers[0]!.send.mock.calls.map(([message]) => message.type),
    ).toEqual(['arm', 'stop']);
    await exited;
    expect((await pending).message).toBeTruthy();
    test.peers[0]!.emit('message', { type: 'armed' });
    expect(test.fork).toHaveBeenCalledOnce();
  });

  it('reuses the inherited IPC peer without creating another supervisor', async () => {
    const test = controller({ inherited: true });
    await test.restart.setEnabled(true);
    expect(test.fork).not.toHaveBeenCalled();
    expect(
      test.process.send.mock.calls.map(([message]) => message.type),
    ).toEqual(['arm']);
    await test.restart.setEnabled(false);
    expect(test.process.connected).toBe(false);
    expect(test.process.kill).not.toHaveBeenCalled();
    await test.restart.setEnabled(true);
    expect(test.fork).toHaveBeenCalledOnce();
  });

  it('does not rearm an inherited peer after its stop handshake times out', async () => {
    const test = controller({ inherited: true });
    await test.restart.setEnabled(true);
    test.process.acknowledgeStop = 'ack-only';
    const stopped = test.restart
      .setEnabled(false)
      .catch((error: Error) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await stopped).message).toContain('未在限定时间内响应');

    test.process.emit('message', { type: 'armed' });
    await expect(test.restart.setEnabled(true)).rejects.toThrow(
      '自动重启辅助进程停止尚未确认，不能重新启用。',
    );
    expect(
      test.process.send.mock.calls.map(([message]) => message.type),
    ).toEqual(['arm', 'stop']);

    test.process.end(17);
    await test.restart.setEnabled(true);
    expect(test.fork).toHaveBeenCalledOnce();
  });

  it('reports inherited stop failure without killing its parent peer', async () => {
    const test = controller({ inherited: true });
    await test.restart.setEnabled(true);
    test.process.acknowledgeStop = 'none';
    const stopped = test.restart
      .setEnabled(false)
      .catch((error: Error) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await stopped).message).toContain('未在限定时间内响应');
    expect(test.process.kill).not.toHaveBeenCalled();
    expect(test.process.disconnect).not.toHaveBeenCalled();
    expect(test.fork).not.toHaveBeenCalled();
  });

  it('reports unexpected helper loss once and permits a fresh explicit enable', async () => {
    const test = controller();
    await test.restart.setEnabled(true);
    test.peers[0]!.end(17);
    expect(test.failure).toHaveBeenCalledOnce();
    await test.restart.setEnabled(true);
    expect(test.fork).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      packaged: false,
      argv: ['/electron', '/fixtures/app.cjs', '--debug-profile'],
      args: ['/fixtures/app.cjs', '--debug-profile'],
    },
    {
      packaged: false,
      argv: ['/electron', '.', '--', '--portable'],
      args: ['/source/desktop', '--', '--portable'],
    },
    {
      packaged: true,
      argv: ['/electron', '--portable', 'lesson'],
      args: ['--portable', 'lesson'],
    },
  ])(
    'preserves launch entry and arguments for $argv',
    async ({ packaged, argv, args }) => {
      const environment = {
        ELECTRON_RUN_AS_NODE: 'old',
        NODE_CHANNEL_FD: '3',
        NODE_CHANNEL_SERIALIZATION_MODE: 'json',
        [protocol.restartPeerVariable]: '/old',
        SAFE: 'kept',
      };
      const original = { ...environment };
      const test = controller({ packaged, argv, environment });
      await test.restart.setEnabled(true);
      const [entry, arguments_, options] = test.fork.mock
        .calls[0] as unknown as [string, string[], Record<string, unknown>];
      expect(entry).toBe('/bundle/main/restart-supervisor.cjs');
      expect(arguments_).toEqual([]);
      expect(options).toMatchObject({
        execPath: '/electron',
        execArgv: [],
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ELECTRON_RUN_AS_NODE: '1', SAFE: 'kept' },
      });
      expect(options.env).not.toHaveProperty('NODE_CHANNEL_FD');
      expect(options.env).not.toHaveProperty('NODE_CHANNEL_SERIALIZATION_MODE');
      expect(options.env).not.toHaveProperty(protocol.restartPeerVariable);
      expect(test.peers[0]!.send.mock.calls[0]![0]).toEqual({
        type: 'arm',
        launch: {
          execPath: '/electron',
          args,
          cwd: '/source/desktop',
          userData: '/actual/profile',
        },
      });
      expect(environment).toEqual(original);
    },
  );

  it('restores inherited userData before profile initialization even after disconnect', async () => {
    const inherited = controller({ inherited: true });
    expect(inherited.exports.restoreRestartProfile(inherited.app)).toBe(true);
    expect(inherited.app.setPath).toHaveBeenCalledWith(
      'userData',
      '/actual/profile',
    );
    const disconnected = controller({
      environment: { [protocol.restartPeerVariable]: '/actual/profile' },
    });
    expect(disconnected.exports.restoreRestartProfile(disconnected.app)).toBe(
      true,
    );
    expect(disconnected.app.setPath).toHaveBeenCalledWith(
      'userData',
      '/actual/profile',
    );
    expect(disconnected.process.connected).toBe(false);
    await disconnected.restart.setEnabled(true);
    expect(disconnected.fork).toHaveBeenCalledOnce();

    const invalid = controller({
      environment: { [protocol.restartPeerVariable]: 'relative/profile' },
    });
    expect(invalid.exports.restoreRestartProfile(invalid.app)).toBe(false);
    expect(invalid.app.setPath).not.toHaveBeenCalled();
  });
});

describe('restart supervisor', () => {
  it('exits without recovery if its first peer disconnects before arming', async () => {
    const test = supervisor();
    test.process.disconnect();
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.process.exit).toHaveBeenCalledWith(0);
    expect(test.spawn).not.toHaveBeenCalled();
  });

  it('recovers the first disconnect then observes only owned child exit', async () => {
    const test = supervisor();
    const original = { ...test.process.env };
    test.arm();
    expect(test.process.send).toHaveBeenCalledWith(
      { type: 'armed' },
      undefined,
      undefined,
      expect.any(Function),
    );
    test.process.disconnect();
    await vi.advanceTimersByTimeAsync(999);
    expect(test.spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.spawn).toHaveBeenCalledWith('/electron', test.launch.args, {
      cwd: '/fixtures',
      env: { SAFE: 'kept', [protocol.restartPeerVariable]: '/actual/profile' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    expect(test.process.env).toEqual(original);
    test.children[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.spawn).toHaveBeenCalledOnce();
    test.children[0]!.end(17);
    await vi.advanceTimersByTimeAsync(1999);
    expect(test.spawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.spawn).toHaveBeenCalledTimes(2);
  });

  it('ends the chain when the owned GUI exits normally without a stop acknowledgement', async () => {
    const test = supervisor();
    test.arm();
    test.process.disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    test.children[0]!.end(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.process.exit).toHaveBeenCalledWith(0);
    expect(test.spawn).toHaveBeenCalledOnce();
  });

  it('caps early crashes at three attempts with 1/2/4 second backoff', async () => {
    const test = supervisor();
    test.arm();
    test.process.disconnect();
    for (const [index, delay] of [1000, 2000, 4000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(test.spawn).toHaveBeenCalledTimes(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(test.spawn).toHaveBeenCalledTimes(index + 1);
      test.children[index]!.end(17);
    }
    expect(test.process.exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(300000);
    expect(test.spawn).toHaveBeenCalledTimes(3);
  });

  it('does not reset the restart budget when recovered children arm and become ready', async () => {
    const test = supervisor();
    test.arm();
    test.process.disconnect();
    for (const [index, delay] of [1000, 2000, 4000].entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      const child = test.children[index]!;
      child.emit('message', { type: 'arm', launch: test.launch });
      child.emit('message', { type: 'ready' });
      child.end(17);
    }
    expect(test.spawn).toHaveBeenCalledTimes(3);
    expect(test.process.exit).toHaveBeenCalledWith(0);
  });

  it('charges synchronous spawn failures to the same finite budget', async () => {
    const test = supervisor();
    test.spawn.mockImplementation(() => {
      throw new Error('Cannot execute');
    });
    test.arm();
    test.process.disconnect();
    await vi.advanceTimersByTimeAsync(7000);
    expect(test.spawn).toHaveBeenCalledTimes(3);
    expect(test.process.exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(300000);
    expect(test.spawn).toHaveBeenCalledTimes(3);
  });

  it('does not double-recover when spawn error is followed by exit', async () => {
    const test = supervisor();
    test.arm();
    test.process.disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    test.children[0]!.emit('error', new Error('Spawn failed'));
    test.children[0]!.end(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.spawn).toHaveBeenCalledTimes(2);
  });

  it('exits after manual stop even if the IPC flush callback is lost', async () => {
    const test = supervisor();
    test.arm();
    test.process.completeSend = false;

    test.process.emit('message', { type: 'stop' });
    expect(test.process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(test.process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.process.exit).toHaveBeenCalledWith(0);
  });

  it('acknowledges stop and leaves the recovered GUI alive', async () => {
    const test = supervisor();
    test.arm();
    test.process.disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    const child = test.children[0]!;
    child.acknowledgeStop = 'none';
    child.emit('message', { type: 'stop' });
    expect(child.send).toHaveBeenCalledWith(
      { type: 'stopped' },
      undefined,
      undefined,
      expect.any(Function),
    );
    expect(child.connected).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.exitCode).toBeNull();
    expect(test.process.exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.spawn).toHaveBeenCalledOnce();
  });

  it('cancels pending backoff when the owned helper is stopped', async () => {
    const test = supervisor();
    test.arm();
    test.process.disconnect();
    test.process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.process.exit).toHaveBeenCalledWith(0);
    expect(test.spawn).not.toHaveBeenCalled();
  });

  it('expires old attempts only after the five minute window', async () => {
    const test = supervisor();
    test.arm();
    test.process.disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(300001);
    test.children[0]!.end(17);
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.spawn).toHaveBeenCalledTimes(2);
    test.children[1]!.end(17);
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.spawn).toHaveBeenCalledTimes(3);
    expect(test.process.exit).not.toHaveBeenCalled();
  });
});
