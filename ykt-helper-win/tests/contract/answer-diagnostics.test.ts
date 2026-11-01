import { describe, expect, it } from 'vitest';
import { BrowserEnvironment, type AutomationLogInput } from '@ykt/contracts';
import { ActiveRequestError, YuketangActiveClient } from '@ykt/routing';
import { MemoryAppDataStore, MemorySecretStore } from '@ykt/storage';
import type { WebContents } from 'electron';
import { recordAutomationLog } from '../../apps/desktop/main/automation-log.js';
import { ElectronSessionCredentialSource } from '../../apps/desktop/main/electron-session-credentials.js';

describe('answer request diagnostics', () => {
  it.each([400, 200])(
    'retains HTTP and business errors without headers or response data (%s)',
    async (status) => {
      const client = new YuketangActiveClient({
        credentials: {
          load: async () => ({
            cookieHeader: 'session=private-cookie',
            bearerToken: 'private-bearer',
            userId: '42',
          }),
        },
        transport: {
          request: async () => ({
            status,
            headers: { 'set-cookie': 'private-cookie' },
            body: {
              code: 40001,
              msg: `token=private-token Bearer private-bearer ${'x'.repeat(2000)}`,
              data: { answer: 'private-answer', lessonToken: 'private-token' },
            },
          }),
        },
      });
      const error = await client
        .submit(BrowserEnvironment.Standard, '7', {
          route: 'answer',
          payload: { result: ['private-answer'] },
        })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ActiveRequestError);
      expect(error).toMatchObject({
        diagnostic: {
          method: 'POST',
          endpoint: 'https://www.yuketang.cn/api/v3/lesson/problem/answer',
          httpStatus: status,
          businessCode: 40001,
        },
      });
      const diagnostic = (error as ActiveRequestError).diagnostic;
      expect(diagnostic.serverMessage!.length).toBeLessThanOrEqual(1024);
      expect(JSON.stringify(error)).not.toMatch(
        /private-(cookie|bearer|token|answer)/,
      );
    },
  );

  it('tracks page rotations without reverting a newer active Set-Auth to an unchanged page value', async () => {
    let pageAuth = 'page-initial';
    const requests: string[] = [];
    const client = new YuketangActiveClient({
      credentials: new ElectronSessionCredentialSource(
        () =>
          ({
            getURL: () =>
              'https://www.yuketang.cn/lesson/fullscreen/v3/7/ppt/1',
            executeJavaScript: async () => pageAuth,
            session: { cookies: { get: async () => [] } },
          }) as unknown as WebContents,
        new MemorySecretStore(),
      ),
      transport: {
        request: async (request) => {
          requests.push(request.headers.authorization ?? '');
          return {
            status: 200,
            headers: requests.length === 1 ? { 'set-auth': 'active-new' } : {},
            body: { data: { onLessonClassrooms: [] } },
          };
        },
      },
    });
    await client.listLessons(BrowserEnvironment.Standard);
    await client.listLessons(BrowserEnvironment.Standard);
    pageAuth = 'page-rotated';
    await client.listLessons(BrowserEnvironment.Standard);
    expect(requests).toEqual([
      'Bearer page-initial',
      'Bearer active-new',
      'Bearer page-rotated',
    ]);
  });
});

describe('restricted automation log persistence', () => {
  const event: AutomationLogInput = {
    stage: 'failed',
    lessonId: '7',
    problemId: '11',
    deadlineAt: 60000,
    remainingMs: 59000,
    delayMs: null,
    managedSubmit: true,
    reason: 'token=private-token',
  };

  it('persists searchable stages and redacts errors independently of notifications', async () => {
    const store = new MemoryAppDataStore();
    await store.updateSettings({ notifyProblems: false });
    await recordAutomationLog(store, event);
    expect(await store.listLogs()).toMatchObject([
      {
        scope: 'automation',
        level: 'error',
        details: {
          stage: 'failed',
          problemId: '11',
          confirmedBy: 'agent',
          reason: 'token=[REDACTED]',
        },
      },
    ]);
  });

  it.each([
    null,
    {},
    { ...event, stage: 'arbitrary' },
    { ...event, remainingMs: Infinity },
    { ...event, reason: 'x'.repeat(2049) },
    { ...event, authorization: 'unexpected' },
  ])('rejects malformed or arbitrary payloads (%j)', async (input) => {
    const store = new MemoryAppDataStore();
    await expect(recordAutomationLog(store, input)).rejects.toThrow(
      'Invalid automation diagnostic',
    );
    expect(await store.listLogs()).toEqual([]);
  });
});
