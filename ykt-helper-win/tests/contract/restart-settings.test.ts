import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createBackendRuntime } from '@ykt/backend';
import { DefaultAppSettings } from '@ykt/contracts';
import { MemoryAppDataStore, SqliteAppDataStore } from '@ykt/storage';
import { describe, expect, it, onTestFinished } from 'vitest';

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ykt-restart-settings-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'settings.sqlite');
}

describe('automatic restart settings', () => {
  it('defaults to disabled in the settings contract and datastore', async () => {
    expect(DefaultAppSettings.autoRestartEnabled).toBe(false);
    const store = new MemoryAppDataStore();
    expect((await store.getSettings()).autoRestartEnabled).toBe(false);
  });

  it.each([true, false])(
    'persists %j when the SQLite datastore is reopened',
    async (enabled) => {
      const path = databasePath();
      const first = new SqliteAppDataStore(path);
      try {
        await first.updateSettings({ autoRestartEnabled: !enabled });
        await first.updateSettings({ autoRestartEnabled: enabled });
      } finally {
        first.close();
      }
      const reopened = new SqliteAppDataStore(path);
      try {
        expect((await reopened.getSettings()).autoRestartEnabled).toBe(enabled);
      } finally {
        reopened.close();
      }
    },
  );

  it('keeps restart disabled for an older database without the setting', async () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    try {
      database.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      database
        .prepare('INSERT INTO settings VALUES (?, ?, ?)')
        .run('keepScreenAwake', 'true', '2026-10-29T00:00:00.000Z');
    } finally {
      database.close();
    }
    const store = new SqliteAppDataStore(path);
    try {
      expect(await store.getSettings()).toMatchObject({
        keepScreenAwake: true,
        autoRestartEnabled: false,
      });
    } finally {
      store.close();
    }
  });

  it('allows external settings updates and resets restart to disabled', async () => {
    const runtime = createBackendRuntime();
    try {
      expect(
        (await runtime.facade.updateSettings({ autoRestartEnabled: true }))
          .autoRestartEnabled,
      ).toBe(true);
      expect((await runtime.facade.resetSettings()).autoRestartEnabled).toBe(
        false,
      );
      expect((await runtime.facade.getSettings()).autoRestartEnabled).toBe(
        false,
      );
      expect(
        (await runtime.facade.updateSettings({ autoRestartEnabled: false }))
          .autoRestartEnabled,
      ).toBe(false);
    } finally {
      await runtime.stop();
    }
  });
});
