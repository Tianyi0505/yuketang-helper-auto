import { spawn, type ChildProcess } from 'node:child_process';

import {
  isLaunchSpec,
  restartEnvironment,
  type LaunchSpec,
  type RestartReply,
  type RestartRequest,
} from './restart-protocol.js';

type State =
  | { phase: 'unarmed' }
  | { phase: 'initial'; launch: LaunchSpec }
  | { phase: 'owned'; launch: LaunchSpec; child: ChildProcess }
  | { phase: 'backoff'; launch: LaunchSpec; timer: NodeJS.Timeout }
  | { phase: 'stopped' };

let state: State = { phase: 'unarmed' };
const attempts: number[] = [];
const budgetWindowMs = 5 * 60 * 1000;
const stopExitFallbackMs = 250;
let finished = false;

type Peer = ChildProcess | NodeJS.Process;

function finish(): void {
  if (finished) return;
  finished = true;
  if (state.phase === 'backoff') clearTimeout(state.timer);
  state = { phase: 'stopped' };
  process.exit(0);
}

function reply(peer: Peer, message: RestartReply, done?: () => void): void {
  if (!peer.connected || !peer.send) {
    done?.();
    return;
  }
  try {
    peer.send(message, undefined, undefined, (error: Error | null) => {
      if (error && !done) finish();
      done?.();
    });
  } catch {
    if (done) done();
    else finish();
  }
}

function handleMessage(peer: Peer, message: unknown): void {
  const isCurrent =
    peer === process
      ? state.phase === 'unarmed' || state.phase === 'initial'
      : state.phase === 'owned' && state.child === peer;
  if (!isCurrent || !message || typeof message !== 'object') return;
  const request = message as RestartRequest;
  if (request.type === 'stop') {
    state = { phase: 'stopped' };
    const fallback = setTimeout(finish, stopExitFallbackMs);
    reply(peer, { type: 'stopped' }, () => {
      clearTimeout(fallback);
      if (peer.connected) peer.disconnect?.();
      finish();
    });
  } else if (request.type === 'arm' && isLaunchSpec(request.launch)) {
    if (state.phase === 'unarmed' || state.phase === 'initial')
      state = { phase: 'initial', launch: request.launch };
    else if (state.phase === 'owned') state.launch = request.launch;
    reply(peer, { type: 'armed' });
  }
}

function recover(launch: LaunchSpec): void {
  const now = Date.now();
  while (attempts.length && attempts[0]! <= now - budgetWindowMs)
    attempts.shift();
  if (attempts.length >= 3) {
    finish();
    return;
  }
  const timer = setTimeout(
    () => {
      if (state.phase !== 'backoff' || state.timer !== timer) return;
      attempts.push(Date.now());
      let child: ChildProcess;
      try {
        child = spawn(launch.execPath, launch.args, {
          cwd: launch.cwd,
          env: restartEnvironment(process.env, launch.userData),
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        });
      } catch {
        recover(launch);
        return;
      }
      state = { phase: 'owned', launch, child };
      child.on('message', (message) => handleMessage(child, message));
      child.once('error', () => {
        if (state.phase === 'owned' && state.child === child)
          recover(state.launch);
      });
      child.once('exit', (code, signal) => {
        if (state.phase !== 'owned' || state.child !== child) return;
        if (code === 0 && signal === null) finish();
        else recover(state.launch);
      });
    },
    1000 * 2 ** attempts.length,
  );
  state = { phase: 'backoff', launch, timer };
}

process.on('message', (message) => handleMessage(process, message));
process.once('disconnect', () => {
  if (state.phase === 'initial') recover(state.launch);
  else if (state.phase === 'unarmed') finish();
});
process.once('SIGTERM', finish);
process.once('SIGINT', finish);
if (!process.connected) finish();
