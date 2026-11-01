import { BrowserEnvironment, type ClassroomNotice } from '@ykt/contracts';
import { BrowserLessonCollector, YuketangActiveClient } from '@ykt/routing';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createBackendRuntime } from './runtime.js';

describe('classroom publish lifecycle', () => {
  it('discards pending publishes when the lesson ends before the presentation loads', async () => {
    const fixture = await createFixture();
    await fixture.publish('11');
    await fixture.finish();
    const noticesAtFinish = [...fixture.notices];

    await fixture.loadPresentation();

    expect(fixture.notices).toEqual(noticesAtFinish);
    expect(fixture.notices.at(-1)?.kind).toBe('lesson-finished');
    expect(fixture.runtime.lessons.getSession('7')?.lesson.status).toBe(
      'ended',
    );
    expect(await fixture.runtime.facade.listProblems('7')).toEqual([]);
  });

  it.each(['before', 'after'] as const)(
    'ignores late publishes received %s the presentation loads in an ended lesson',
    async (arrival) => {
      const fixture = await createFixture();
      await fixture.finish();
      const noticesAtFinish = [...fixture.notices];

      if (arrival === 'before') await fixture.publish('11');
      await fixture.loadPresentation();
      if (arrival === 'after') await fixture.publish('11');

      expect(fixture.notices).toEqual(noticesAtFinish);
      expect(await fixture.runtime.facade.listProblems('7')).toEqual([]);
    },
  );

  it.each(['http-error', 'malformed', 'business-error'])(
    'keeps the current lesson on a failed refresh (%s), then retires it on a valid new classroom list',
    async (failure) => {
      const fixture = await createFixture();
      const facade = fixture.runtime.facade;
      await fixture.loadPresentation();
      await fixture.unlock('11');
      fixture.request.mockResolvedValueOnce({
        status: failure === 'http-error' ? 503 : 200,
        headers: {},
        body: failure === 'business-error' ? { code: 1 } : { data: {} },
      });
      await expect(facade.refreshLessons('standard')).rejects.toThrow();
      expect(
        (await facade.listLessons()).find((lesson) => lesson.id === '7')
          ?.status,
      ).toBe('active');
      expect((await facade.getProblem('11')).status).toBe('available');

      fixture.request.mockResolvedValue({
        status: 200,
        headers: {},
        body: { data: { onLessonClassrooms: [{ lessonId: 17 }] } },
      });
      await facade.refreshLessons('standard');
      expect(
        (await facade.listLessons()).find((lesson) => lesson.id === '7')
          ?.status,
      ).toBe('ended');
      expect((await facade.getProblem('11')).status).toBe('expired');
      // Late official frames cannot unlock the retired lesson again.
      await fixture.unlock('12');
      expect((await facade.getProblem('12')).status).toBe('locked');
      await facade.connectLesson('standard', '17');
      expect(
        (await facade.listLessons()).find((lesson) => lesson.id === '17')
          ?.status,
      ).toBe('active');
    },
  );

  it('does not reactivate an ended lesson from a stale list response or reconnect', async () => {
    const fixture = await createFixture();
    await fixture.finish();
    await fixture.runtime.facade.refreshLessons('standard');
    await fixture.runtime.facade.connectLesson('standard', '7');
    await fixture.loadPresentation();
    expect((await fixture.runtime.facade.listLessons())[0]?.status).toBe(
      'ended',
    );
    expect(await fixture.runtime.facade.listProblems('7')).toEqual([]);
  });

  it('loads the deck named by an unlock event when no network response was observed', async () => {
    const fixture = await createFixture();
    fixture.request.mockImplementation(async (request: { url: string }) => {
      const pathname = new URL(request.url).pathname;
      if (pathname.includes('/lesson/presentation/fetch')) {
        return {
          status: 200,
          headers: {},
          body: {
            data: {
              id: 9,
              title: 'Presentation',
              slides: ['11', '12'].map((problemId) => ({
                id: `slide-${problemId}`,
                problem: {
                  problemId,
                  problemType: 1,
                  content: `Question ${problemId}`,
                  options: ['One', 'Two'],
                },
              })),
            },
          },
        };
      }
      return {
        status: 200,
        headers: {},
        body: {
          data: {
            onLessonClassrooms: [
              {
                lessonId: 7,
                classroomId: 8,
                presentationId: 9,
                title: 'Active lesson',
              },
            ],
          },
        },
      };
    });

    await fixture.unlock('11');

    const problem = await fixture.runtime.facade.getProblem('11');
    expect(problem.status).toBe('available');
    expect(fixture.notices.at(-1)?.kind).toBe('problem-start');
    const logs = await fixture.runtime.facade.listLogs(100);
    expect(logs.map((log) => log.message)).toContain('已按题目事件补取课件。');
  });

  it('stops an in-progress replay when the lesson ends between publishes', async () => {
    const fixture = await createFixture();
    await fixture.publish('11');
    await fixture.publish('12');
    const storage = fixture.runtime.dataStore;
    const appendLog = storage.appendLog.bind(storage);
    vi.spyOn(storage, 'appendLog').mockImplementation(async (entry) => {
      await appendLog(entry);
      if (
        entry.message === '已应用题目发布事件到状态机。' &&
        entry.details?.problemId === '11'
      ) {
        await fixture.finish();
      }
    });

    await fixture.loadPresentation();

    expect(fixture.notices.map((notice) => notice.kind)).toEqual([
      'assessment-publish',
      'assessment-publish',
      'problem-start',
      'lesson-finished',
    ]);
    expect(await fixture.runtime.facade.listProblems('7')).toHaveLength(2);
  });
});

async function createFixture() {
  const notices: ClassroomNotice[] = [];
  const collector = new BrowserLessonCollector();
  const request = vi.fn(
    async (): Promise<{
      status: number;
      headers: Record<string, string>;
      body: unknown;
    }> => ({
      status: 200,
      headers: {},
      body: {
        data: {
          onLessonClassrooms: [
            {
              lessonId: 7,
              classroomId: 8,
              presentationId: 9,
              title: 'Active lesson',
            },
          ],
        },
      },
    }),
  );
  const activeClient = new YuketangActiveClient({
    credentials: {
      load: async () => ({
        cookieHeader: 'session=fixture',
        bearerToken: null,
        userId: '42',
      }),
    },
    transport: { request },
    browserCollector: collector,
    socketFactory: () => {
      throw new Error('Browser collection must not create a classroom socket.');
    },
  });
  const runtime = createBackendRuntime({
    activeClient,
    onClassroomNotice: (notice) => notices.push(notice),
  });
  await runtime.start();
  onTestFinished(() => runtime.stop());
  await runtime.facade.refreshLessons(BrowserEnvironment.Standard);
  await runtime.facade.connectLesson(BrowserEnvironment.Standard, '7');
  await collector.observeWebSocket({
    requestId: 'browser-ws',
    direction: 'sent',
    payload: JSON.stringify({ op: 'hello', lessonid: 7 }),
  });

  const receive = (message: Record<string, unknown>) =>
    collector.observeWebSocket({
      requestId: 'browser-ws',
      direction: 'received',
      payload: JSON.stringify(message),
    });

  return {
    request,
    runtime,
    notices,
    unlock: (problemId: string) =>
      receive({
        op: 'unlockproblem',
        problem: {
          problemId,
          pres: '9',
          sid: `slide-${problemId}`,
          dt: Date.now(),
          limit: 0,
        },
      }),
    publish: (problemId: string) =>
      receive({ op: 'probleminfo', problemid: problemId }),
    finish: () => receive({ op: 'lessonfinished' }),
    loadPresentation: () =>
      collector.observeHttp({
        url: 'https://www.yuketang.cn/api/v3/lesson/presentation/fetch?presentation_id=9',
        statusCode: 200,
        body: JSON.stringify({
          data: {
            id: 9,
            title: 'Presentation',
            slides: ['11', '12'].map((problemId) => ({
              id: `slide-${problemId}`,
              problem: {
                problemId,
                problemType: 1,
                content: `Question ${problemId}`,
                options: ['One', 'Two'],
              },
            })),
          },
        }),
      }),
  };
}
