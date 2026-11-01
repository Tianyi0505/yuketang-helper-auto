export interface LaunchSpec {
  execPath: string;
  args: string[];
  cwd: string;
  userData: string;
}

export type RestartRequest =
  { type: 'arm'; launch: LaunchSpec } | { type: 'stop' };

export type RestartReply = { type: 'armed' | 'stopped' };

export const restartPeerVariable = 'YKT_HELPER_RESTART_PEER';

export function restartEnvironment(
  source: NodeJS.ProcessEnv,
  userData?: string,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_CHANNEL_FD;
  delete environment.NODE_CHANNEL_SERIALIZATION_MODE;
  delete environment[restartPeerVariable];
  if (userData !== undefined) environment[restartPeerVariable] = userData;
  return environment;
}

export function isLaunchSpec(value: unknown): value is LaunchSpec {
  if (!value || typeof value !== 'object') return false;
  const launch = value as Record<string, unknown>;
  return (
    typeof launch.execPath === 'string' &&
    launch.execPath.length > 0 &&
    Array.isArray(launch.args) &&
    launch.args.every((argument) => typeof argument === 'string') &&
    typeof launch.cwd === 'string' &&
    launch.cwd.length > 0 &&
    typeof launch.userData === 'string' &&
    launch.userData.length > 0
  );
}
