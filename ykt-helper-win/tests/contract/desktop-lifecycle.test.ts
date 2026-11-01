import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

import * as contracts from '@ykt/contracts';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sourceUrl = new URL('../../apps/desktop/main/index.ts', import.meta.url);
const mainScript = new Script(
  ts.transpileModule(readFileSync(sourceUrl, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText,
  { filename: fileURLToPath(sourceUrl) },
);
const nextTurn = setImmediate;
const flush = () => new Promise<void>((resolve) => nextTurn(resolve));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function preventable() {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

type DesktopOptions = {
  platform?: NodeJS.Platform;
  ready?: Promise<void>;
  runtimeStart?: () => Promise<void>;
  runtimeStop?: () => Promise<void>;
  cliStart?: () => Promise<void>;
  cliClose?: () => Promise<void>;
  autoRestartEnabled?: boolean;
  cacheOpen?: () => Promise<void>;
  restartSetEnabled?: (enabled: boolean) => Promise<void>;
  restartNormalExit?: () => Promise<void>;
  singleInstanceLock?: boolean;
  argv?: string[];
  inheritedUserData?: string;
};

function startDesktop(options: DesktopOptions = {}) {
  const windows: FakeWindow[] = [];
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    acceptingQuit: false,
    didQuit: false,
    getPath: vi.fn((name: string) => `/desktop/${name}`),
    setPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => options.singleInstanceLock ?? true),
    isReady: () => true,
    whenReady: () => options.ready ?? Promise.resolve(),
    quit: vi.fn(() => {
      if (app.didQuit) return;
      const event = preventable();
      app.emit('before-quit', event);
      if (event.defaultPrevented) return;
      app.acceptingQuit = true;
      for (const window of windows) window.close();
      app.didQuit = true;
      app.emit('will-quit');
    }),
  });
  const willQuit = vi.fn();
  app.on('will-quit', willQuit);

  class FakeWindow extends EventEmitter {
    destroyed = false;
    minimized = false;
    readonly webContents = {
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      getURL: () => 'file:///desktop/renderer/index.html',
    };
    readonly hide = vi.fn();
    readonly show = vi.fn();
    readonly focus = vi.fn();
    readonly restore = vi.fn(() => {
      this.minimized = false;
    });
    readonly loadFile = vi.fn(async () => {});

    constructor(readonly options: { webPreferences?: object } = {}) {
      super();
      windows.push(this);
    }

    static getAllWindows() {
      return windows.filter((window) => !window.destroyed);
    }

    isDestroyed() {
      return this.destroyed;
    }

    isMinimized() {
      return this.minimized;
    }

    minimize() {
      this.minimized = true;
      this.emit('minimize');
    }

    close() {
      if (this.destroyed) return;
      const event = preventable();
      this.emit('close', event);
      if (!event.defaultPrevented) {
        this.destroyed = true;
        this.emit('closed');
        if (!app.acceptingQuit && FakeWindow.getAllWindows().length === 0) {
          app.emit('window-all-closed');
        }
      }
      return event;
    }
  }

  const browser = {
    webContents: { session: { fetch: vi.fn(), cookies: { get: vi.fn() } } },
    onWebContentsCreated: vi.fn(),
    start: vi.fn(async () => {}),
    refreshLayout: vi.fn(),
    getState: () => ({ url: 'https://www.yuketang.cn/web' }),
    destroy: vi.fn(),
  };
  const recorder = { entries: [] };
  const networkLab = {
    recorder,
    start: vi.fn(async () => {}),
    destroy: vi.fn(),
  };
  const webProbe = { cancel: vi.fn() };
  let settings: contracts.AppSettings = {
    ...contracts.DefaultAppSettings,
    autoRestartEnabled: options.autoRestartEnabled ?? false,
    browserEnvironment: contracts.BrowserEnvironment.Standard,
  };
  const facade = {
    getSettings: vi.fn(async () => ({ ...settings })),
    updateSettings: vi.fn(async (patch: Partial<contracts.AppSettings>) => {
      settings = { ...settings, ...patch };
      return { ...settings };
    }),
    resetSettings: vi.fn(async () => {
      settings = { ...contracts.DefaultAppSettings };
      return { ...settings };
    }),
  };
  const restart = {
    setEnabled: vi.fn(options.restartSetEnabled ?? (async () => {})),
    prepareNormalExit: vi.fn(options.restartNormalExit ?? (async () => {})),
  };
  let restartFailure: ((error: Error) => void) | undefined;
  const createAutoRestart = vi.fn(
    (
      _app: unknown,
      _moduleDirectory: string,
      onFailure: (error: Error) => void,
    ) => {
      restartFailure = onFailure;
      return restart;
    },
  );
  const handlers = new Map<
    string,
    (...arguments_: any[]) => Promise<unknown>
  >();
  const runtime = {
    facade,
    start: vi.fn(options.runtimeStart ?? (async () => {})),
    stop: vi.fn(options.runtimeStop ?? (async () => {})),
  };
  const cli = {
    start: vi.fn(options.cliStart ?? (async () => {})),
    close: vi.fn(options.cliClose ?? (async () => {})),
  };
  const dataStore = {
    getSettings: facade.getSettings,
    updateSettings: facade.updateSettings,
    close: vi.fn(),
  };
  let cacheOpenStarted = false;
  const resourceCache = { close: vi.fn() };
  const desktopCliServer = vi.fn(function () {
    return cli;
  });
  const tray = vi.fn(function () {
    return Object.assign(new EventEmitter(), {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
    });
  });
  const logs = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const modules: Record<string, unknown> = {
    'node:fs': { existsSync: (value: string) => value.endsWith('.ico') },
    'node:fs/promises': { writeFile: vi.fn() },
    'node:path': path,
    electron: {
      app,
      BrowserWindow: FakeWindow,
      ipcMain: {
        handle: (
          channel: string,
          handler: (...arguments_: any[]) => Promise<unknown>,
        ) => {
          handlers.set(channel, handler);
        },
      },
      Menu: {
        setApplicationMenu: vi.fn(),
        buildFromTemplate: (value: unknown) => value,
      },
      Tray: tray,
      powerSaveBlocker: {
        start: vi.fn(),
        stop: vi.fn(),
        isStarted: () => false,
      },
    },
    '@ykt/contracts': contracts,
    '@ykt/backend': { createBackendRuntime: () => runtime },
    '@ykt/routing': {
      BrowserLessonCollector: class {
        onCollectionStatusChanged = vi.fn();
      },
      YuketangActiveClient: class {},
    },
    '@ykt/storage': {
      SqliteAppDataStore: class {
        constructor() {
          return dataStore;
        }
      },
      DiskResourceCache: {
        open: async () => {
          cacheOpenStarted = true;
          await options.cacheOpen?.();
          return resourceCache;
        },
      },
      FileSecretStore: class {},
    },
    'electron-squirrel-startup': false,
    './assignment-assets.js': { AssignmentAssets: class {} },
    './assignment-answer-window.js': {},
    './automation-log.js': {},
    './auto-restart.js': {
      createAutoRestart,
      restoreRestartProfile: () => {
        if (!options.inheritedUserData) return false;
        app.setPath('userData', options.inheritedUserData);
        return true;
      },
    },
    './browser-controller.js': {
      BrowserController: class {
        constructor() {
          return browser;
        }
      },
    },
    './browser-policy.js': { isClassroomUrl: () => false },
    './cli-handler.js': { createDesktopCliHandler: () => ({}) },
    './cli-desktop-controls.js': { createCliDesktopControls: () => ({}) },
    './cli-server.js': { DesktopCliServer: desktopCliServer },
    './chromium-http-transport.js': { ChromiumHttpTransport: class {} },
    './electron-session-credentials.js': {
      ElectronSessionCredentialSource: class {},
    },
    './electron-safe-storage-codec.js': { ElectronSafeStorageCodec: class {} },
    './media-export.js': {},
    './web-probe-controller.js': {
      WebProbeController: class {
        constructor() {
          return webProbe;
        }
      },
    },
    './electron-web-probe.js': {},
    './network-lab-controller.js': {
      NetworkLabController: class {
        constructor() {
          return networkLab;
        }
      },
    },
    './network-recorder-factory.js': {
      createNetworkRecorderForDesktop: async () => recorder,
    },
    './source-modules.js': {},
  };
  mainScript.runInNewContext({
    require: (id: string) => {
      if (!(id in modules))
        throw new Error(`Unexpected desktop dependency: ${id}`);
      return modules[id];
    },
    exports: {},
    __dirname: path.dirname(fileURLToPath(sourceUrl)),
    process: {
      argv: options.argv ?? [],
      platform: options.platform ?? 'win32',
      resourcesPath: '/desktop/resources',
    },
    console: logs,
    setTimeout,
    clearTimeout,
  });
  return {
    app,
    windows,
    Window: FakeWindow,
    browser,
    networkLab,
    webProbe,
    runtime,
    cli,
    tray,
    logs,
    willQuit,
    restart,
    createAutoRestart,
    facade,
    cacheOpenStarted: () => cacheOpenStarted,
    reportRestartFailure: (error: Error) => restartFailure?.(error),
    invoke: (channel: string, patch?: unknown) => {
      const sender = windows[0]!.webContents;
      return handlers.get(channel)!(
        { sender, senderFrame: { url: sender.getURL() } },
        patch,
      );
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each(['win32', 'darwin', 'linux'] as const)(
  'desktop window lifecycle on %s',
  (platform) => {
    it('closes rather than hides and cleans up each resource once', async () => {
      const desktop = startDesktop({ platform });
      await flush();
      const window = desktop.windows[0]!;

      expect(window.close()?.defaultPrevented).toBe(false);
      window.close();
      await flush();

      expect(window.hide).not.toHaveBeenCalled();
      expect(desktop.tray).not.toHaveBeenCalled();
      expect(desktop.Window.getAllWindows()).toHaveLength(0);
      expect(desktop.webProbe.cancel).toHaveBeenCalledOnce();
      expect(desktop.networkLab.destroy).toHaveBeenCalledOnce();
      expect(desktop.browser.destroy).toHaveBeenCalledOnce();
      expect(desktop.cli.close).toHaveBeenCalledOnce();
      expect(desktop.runtime.stop).toHaveBeenCalledOnce();
      expect(desktop.willQuit).toHaveBeenCalledOnce();
    });

    it('keeps automation services running when minimized', async () => {
      const desktop = startDesktop({ platform });
      await flush();
      const window = desktop.windows[0]!;

      window.minimize();
      await flush();

      expect(window.options.webPreferences).toMatchObject({
        backgroundThrottling: false,
      });
      expect(window.isDestroyed()).toBe(false);
      expect(desktop.app.quit).not.toHaveBeenCalled();
      expect(desktop.cli.close).not.toHaveBeenCalled();
      expect(desktop.runtime.stop).not.toHaveBeenCalled();
      expect(desktop.browser.destroy).not.toHaveBeenCalled();
      expect(desktop.networkLab.destroy).not.toHaveBeenCalled();
    });

    it('restores and focuses the existing window for a second instance', async () => {
      const desktop = startDesktop({ platform });
      await flush();
      const window = desktop.windows[0]!;
      window.minimize();
      const shown = window.show.mock.calls.length;

      desktop.app.emit('second-instance');
      await flush();

      expect(window.restore).toHaveBeenCalledOnce();
      expect(window.show).toHaveBeenCalledTimes(shown + 1);
      expect(window.focus).toHaveBeenCalledOnce();
      expect(desktop.windows).toHaveLength(1);
      expect(desktop.runtime.stop).not.toHaveBeenCalled();
    });

    it('waits for the last window and does not recreate the closed main window', async () => {
      const desktop = startDesktop({ platform });
      await flush();
      const child = new desktop.Window();

      desktop.windows[0]!.close();
      await flush();
      desktop.app.emit('second-instance');
      desktop.app.emit('activate');
      await flush();

      expect(desktop.windows).toHaveLength(2);
      expect(desktop.app.quit).not.toHaveBeenCalled();
      child.close();
      await flush();
      expect(desktop.willQuit).toHaveBeenCalledOnce();
    });
  },
);

describe('desktop service shutdown', () => {
  it('waits for both services before allowing the final quit', async () => {
    const stopped = deferred();
    const closed = deferred();
    const desktop = startDesktop({
      runtimeStop: () => stopped.promise,
      cliClose: () => closed.promise,
    });
    await flush();

    desktop.app.quit();
    stopped.resolve();
    await flush();
    expect(desktop.willQuit).not.toHaveBeenCalled();
    closed.resolve();
    await flush();

    expect(desktop.willQuit).toHaveBeenCalledOnce();
    expect(desktop.cli.close).toHaveBeenCalledOnce();
    expect(desktop.runtime.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(desktop.logs.warn).not.toHaveBeenCalled();
  });

  it('coalesces repeated quit requests and never rebuilds during shutdown', async () => {
    const stopped = deferred();
    const desktop = startDesktop({ runtimeStop: () => stopped.promise });
    await flush();
    const window = desktop.windows[0]!;
    const shown = window.show.mock.calls.length;

    desktop.app.quit();
    desktop.app.quit();
    desktop.app.quit();
    desktop.app.emit('second-instance');
    desktop.app.emit('activate');
    await flush();

    expect(desktop.willQuit).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledTimes(shown);
    expect(desktop.cli.close).toHaveBeenCalledOnce();
    expect(desktop.runtime.stop).toHaveBeenCalledOnce();
    const quitRequests = desktop.app.quit.mock.calls.length;
    stopped.resolve();
    await flush();

    expect(desktop.app.quit).toHaveBeenCalledTimes(quitRequests + 1);
    expect(desktop.willQuit).toHaveBeenCalledOnce();
    desktop.app.emit('activate');
    desktop.app.emit('second-instance');
    await flush();
    expect(desktop.windows).toHaveLength(1);
  });

  it.each(['runtime', 'cli'] as const)(
    'still exits when %s cleanup rejects',
    async (service) => {
      const fail = async () => {
        throw new Error('Cleanup failed.');
      };
      const desktop = startDesktop(
        service === 'runtime' ? { runtimeStop: fail } : { cliClose: fail },
      );
      await flush();

      desktop.windows[0]!.close();
      await flush();

      expect(desktop.cli.close).toHaveBeenCalledOnce();
      expect(desktop.runtime.stop).toHaveBeenCalledOnce();
      expect(desktop.willQuit).toHaveBeenCalledOnce();
    },
  );

  it('allows quit at 5000ms and ignores late cleanup completion', async () => {
    const stopped = deferred();
    const desktop = startDesktop({ runtimeStop: () => stopped.promise });
    await flush();
    desktop.windows[0]!.close();

    await vi.advanceTimersByTimeAsync(4999);
    expect(desktop.willQuit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(desktop.willQuit).toHaveBeenCalledOnce();
    expect(desktop.logs.warn).toHaveBeenCalledOnce();
    const quitRequests = desktop.app.quit.mock.calls.length;
    stopped.resolve();
    await flush();

    expect(desktop.app.quit).toHaveBeenCalledTimes(quitRequests);
    expect(desktop.cli.close).toHaveBeenCalledOnce();
    expect(desktop.runtime.stop).toHaveBeenCalledOnce();
  });

  it('does not create a window if quit precedes app readiness', async () => {
    const ready = deferred();
    const desktop = startDesktop({ ready: ready.promise });

    desktop.app.quit();
    await flush();
    expect(desktop.willQuit).toHaveBeenCalledOnce();
    ready.resolve();
    await flush();

    expect(desktop.windows).toHaveLength(0);
    expect(desktop.runtime.start).not.toHaveBeenCalled();
  });

  it('does not start CLI after quitting during runtime startup', async () => {
    const started = deferred();
    const desktop = startDesktop({ runtimeStart: () => started.promise });
    await flush();
    expect(desktop.runtime.start).toHaveBeenCalledOnce();

    desktop.app.quit();
    await flush();
    expect(desktop.willQuit).toHaveBeenCalledOnce();
    started.resolve();
    await flush();

    expect(desktop.cli.start).not.toHaveBeenCalled();
    expect(desktop.runtime.stop).toHaveBeenCalledOnce();
  });

  it('still opens the desktop if CLI startup fails', async () => {
    const desktop = startDesktop({
      cliStart: async () => {
        throw new Error('Pipe unavailable.');
      },
    });
    await flush();

    expect(desktop.windows[0]!.show).toHaveBeenCalledOnce();
    expect(desktop.logs.warn).toHaveBeenCalledOnce();
    expect(desktop.app.quit).not.toHaveBeenCalled();
    desktop.windows[0]!.close();
    await flush();
    expect(desktop.willQuit).toHaveBeenCalledOnce();
  });

  it('cleans up and exits if runtime startup fails', async () => {
    const desktop = startDesktop({
      runtimeStart: async () => {
        throw new Error('Runtime unavailable.');
      },
    });
    await flush();

    expect(desktop.logs.error).toHaveBeenCalledOnce();
    expect(desktop.cli.start).not.toHaveBeenCalled();
    expect(desktop.runtime.stop).toHaveBeenCalledOnce();
    expect(desktop.willQuit).toHaveBeenCalledOnce();
  });
});

describe('desktop auto restart integration', () => {
  it('restores the saved setting after acquiring the single instance lock', async () => {
    const desktop = startDesktop({ autoRestartEnabled: true });
    await flush();
    expect(desktop.restart.setEnabled).toHaveBeenCalledWith(true);
    expect(
      desktop.app.requestSingleInstanceLock.mock.invocationCallOrder[0],
    ).toBeLessThan(desktop.createAutoRestart.mock.invocationCallOrder[0]!);
  });

  it('disables restart persistence when the helper fails before runtime assignment', async () => {
    const cacheOpen = deferred();
    const desktop = startDesktop({
      autoRestartEnabled: true,
      cacheOpen: () => cacheOpen.promise,
    });
    await flush();

    expect(desktop.cacheOpenStarted()).toBe(true);
    expect(desktop.runtime.start).not.toHaveBeenCalled();
    desktop.reportRestartFailure(new Error('helper exited'));
    await flush();

    expect(desktop.facade.updateSettings).toHaveBeenCalledWith({
      autoRestartEnabled: false,
    });
    expect(await desktop.facade.getSettings()).toMatchObject({
      autoRestartEnabled: false,
    });

    cacheOpen.resolve();
    await flush();
    desktop.windows[0]!.close();
    await flush();
  });

  it('does not create a controller or helper after failing the single instance lock', async () => {
    const desktop = startDesktop({
      autoRestartEnabled: true,
      singleInstanceLock: false,
    });
    await flush();
    expect(desktop.createAutoRestart).not.toHaveBeenCalled();
    expect(desktop.restart.setEnabled).not.toHaveBeenCalled();
    expect(desktop.windows).toHaveLength(0);
    expect(desktop.willQuit).toHaveBeenCalledOnce();
  });

  it('restores inherited userData without applying debug profile twice', async () => {
    const desktop = startDesktop({
      argv: ['--debug-profile'],
      inheritedUserData: '/actual/debug-profile',
    });
    await flush();
    expect(desktop.app.setPath).toHaveBeenCalledExactlyOnceWith(
      'userData',
      '/actual/debug-profile',
    );
  });

  it.each(['close', 'quit'] as const)(
    'waits for disarm and service cleanup on normal %s',
    async (action) => {
      const disarmed = deferred();
      const cleaned = deferred();
      const desktop = startDesktop({
        autoRestartEnabled: true,
        restartNormalExit: () => disarmed.promise,
        runtimeStop: () => cleaned.promise,
      });
      await flush();
      if (action === 'close') desktop.windows[0]!.close();
      else desktop.app.quit();
      expect(desktop.restart.prepareNormalExit).toHaveBeenCalledOnce();
      expect(
        desktop.restart.prepareNormalExit.mock.invocationCallOrder[0],
      ).toBeLessThan(desktop.runtime.stop.mock.invocationCallOrder[0]!);
      cleaned.resolve();
      await flush();
      expect(desktop.willQuit).not.toHaveBeenCalled();
      disarmed.resolve();
      await flush();
      expect(desktop.willQuit).toHaveBeenCalledOnce();
    },
  );

  it.each(['query-session-end', 'session-end'] as const)(
    'marks normal intent on %s without blocking OS shutdown',
    async (eventName) => {
      const disarmed = deferred();
      const desktop = startDesktop({
        restartNormalExit: () => disarmed.promise,
      });
      await flush();
      const event = preventable();
      desktop.windows[0]!.emit(eventName, event);
      expect(desktop.restart.prepareNormalExit).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(false);
      expect(desktop.app.quit).not.toHaveBeenCalled();
      disarmed.resolve();
    },
  );

  it('serializes settings changes and waits for the enable handshake', async () => {
    const armed = deferred();
    const desktop = startDesktop({
      restartSetEnabled: async (enabled) => {
        if (enabled) await armed.promise;
      },
    });
    await flush();
    let enabledReturned = false;
    const enabling = desktop
      .invoke(contracts.IpcChannel.UpdateSettings, {
        autoRestartEnabled: true,
      })
      .then(() => {
        enabledReturned = true;
      });
    const disabling = desktop.invoke(contracts.IpcChannel.UpdateSettings, {
      autoRestartEnabled: false,
    });
    await flush();
    expect(enabledReturned).toBe(false);
    expect(desktop.facade.updateSettings).toHaveBeenCalledOnce();
    expect(
      desktop.restart.setEnabled.mock.calls.map(([enabled]) => enabled),
    ).toEqual([false, true]);
    armed.resolve();
    await Promise.all([enabling, disabling]);
    expect(await desktop.facade.getSettings()).toMatchObject({
      autoRestartEnabled: false,
    });
    expect(
      desktop.restart.setEnabled.mock.calls.map(([enabled]) => enabled),
    ).toEqual([false, true, false]);
  });

  it('does not enable when persisting settings fails', async () => {
    const desktop = startDesktop();
    await flush();
    desktop.facade.updateSettings.mockRejectedValueOnce(
      new Error('Storage unavailable'),
    );
    await expect(
      desktop.invoke(contracts.IpcChannel.UpdateSettings, {
        autoRestartEnabled: true,
      }),
    ).rejects.toThrow('Storage unavailable');
    expect(
      desktop.restart.setEnabled.mock.calls.map(([enabled]) => enabled),
    ).toEqual([false]);
    expect(await desktop.facade.getSettings()).toMatchObject({
      autoRestartEnabled: false,
    });
  });

  it('continues normal exit after inherited disarm failure instead of waiting forever', async () => {
    const desktop = startDesktop({
      autoRestartEnabled: true,
      restartNormalExit: async () => {
        throw new Error('Inherited peer cannot stop');
      },
    });
    await flush();
    desktop.app.quit();
    await flush();
    expect(desktop.runtime.stop).toHaveBeenCalledOnce();
    expect(desktop.logs.error).toHaveBeenCalledOnce();
    expect(desktop.willQuit).toHaveBeenCalledOnce();
  });

  it('rolls back failed enabling while retaining other saved settings', async () => {
    const desktop = startDesktop({
      restartSetEnabled: async (enabled) => {
        if (enabled) throw new Error('Helper failed to arm');
      },
    });
    await flush();
    await expect(
      desktop.invoke(contracts.IpcChannel.UpdateSettings, {
        autoRestartEnabled: true,
        keepScreenAwake: true,
      }),
    ).rejects.toThrow('已恢复原状态');
    expect(await desktop.facade.getSettings()).toMatchObject({
      autoRestartEnabled: false,
      keepScreenAwake: true,
    });
    expect(
      desktop.restart.setEnabled.mock.calls.map(([enabled]) => enabled),
    ).toEqual([false, true, false]);
  });

  it('reestablishes supervision before rolling back a failed disable', async () => {
    let active = false;
    const desktop = startDesktop({
      autoRestartEnabled: true,
      restartSetEnabled: async (enabled) => {
        if (!enabled && active) {
          active = false;
          throw new Error('Helper exited without stopped acknowledgement');
        }
        active = enabled;
      },
    });
    await flush();
    await expect(
      desktop.invoke(contracts.IpcChannel.UpdateSettings, {
        autoRestartEnabled: false,
      }),
    ).rejects.toThrow('已恢复原状态');
    expect(active).toBe(true);
    expect(await desktop.facade.getSettings()).toMatchObject({
      autoRestartEnabled: true,
    });
    expect(
      desktop.restart.setEnabled.mock.calls.map(([enabled]) => enabled),
    ).toEqual([true, false, true]);
  });

  it('saves disabled and reports failure when supervision cannot be restored', async () => {
    let calls = 0;
    let active = false;
    const desktop = startDesktop({
      autoRestartEnabled: true,
      restartSetEnabled: async (enabled) => {
        calls++;
        if (calls === 2) {
          active = false;
          throw new Error('Stop acknowledgement lost');
        }
        if (calls === 3) throw new Error('Replacement helper failed');
        active = enabled;
      },
    });
    await flush();
    await expect(
      desktop.invoke(contracts.IpcChannel.UpdateSettings, {
        autoRestartEnabled: false,
      }),
    ).rejects.toThrow('未能恢复原状态');
    expect(active).toBe(false);
    expect(await desktop.facade.getSettings()).toMatchObject({
      autoRestartEnabled: false,
    });
    expect(
      desktop.restart.setEnabled.mock.calls.map(([enabled]) => enabled),
    ).toEqual([true, false, true, false]);
  });

  it('disarms when settings are reset', async () => {
    const desktop = startDesktop({ autoRestartEnabled: true });
    await flush();
    const settings = await desktop.invoke(contracts.IpcChannel.ResetSettings);
    expect(settings).toMatchObject({ autoRestartEnabled: false });
    expect(
      desktop.restart.setEnabled.mock.calls.map(([enabled]) => enabled),
    ).toEqual([true, false]);
  });

  it('rolls back a saved startup enable that cannot arm', async () => {
    const desktop = startDesktop({
      autoRestartEnabled: true,
      restartSetEnabled: async () => {
        throw new Error('Missing supervisor');
      },
    });
    await flush();
    expect(await desktop.facade.getSettings()).toMatchObject({
      autoRestartEnabled: false,
    });
    expect(desktop.logs.error).toHaveBeenCalledOnce();
    expect(desktop.windows[0]!.show).toHaveBeenCalledOnce();
  });
});

describe('desktop packaging resources', () => {
  it('keeps CLI and installer icons without shipping a tray-only resource', () => {
    const require = createRequire(import.meta.url);
    const config = require('../../desktop/forge.config.cjs') as {
      packagerConfig: { extraResource: string[]; icon: string };
      makers: { name: string; config?: { setupIcon?: string } }[];
    };
    const directory = fileURLToPath(new URL('../../desktop/', import.meta.url));

    expect(config.packagerConfig.extraResource).toEqual([
      path.join(directory, 'cli', 'ykt-cli.cjs'),
    ]);
    expect(config.packagerConfig.icon).toBe(
      path.join(directory, 'build', 'icon'),
    );
    const installer = config.makers.find(
      (maker) => maker.name === '@electron-forge/maker-squirrel',
    );
    expect(installer?.config?.setupIcon).toBe(
      path.join(directory, 'build', 'icon.ico'),
    );
    expect(existsSync(path.join(directory, 'build', 'icon.ico'))).toBe(true);
  });
});
