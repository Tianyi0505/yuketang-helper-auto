import { effectScope, nextTick, reactive } from 'vue';
import type * as Vue from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BrowserEnvironment,
  DefaultAppSettings,
  ProblemType,
  type AnswerProposal,
  type Lesson,
  type Presentation,
  type ProblemContext,
  type AutomationLogInput,
} from '@ykt/contracts';
import { createBackendRuntime, type AiProviderPlugin } from '@ykt/backend';
import {
  BrowserLessonCollector,
  YuketangActiveClient,
  type ActiveHttpRequest,
} from '@ykt/routing';
import AssistantPanel from '../../apps/desktop/renderer/src/components/AssistantPanel.vue';
import { recordAutomationLog } from '../../apps/desktop/main/automation-log.js';
import { ElectronSessionCredentialSource } from '../../apps/desktop/main/electron-session-credentials.js';
import { MemorySecretStore } from '@ykt/storage';
import type { WebContents } from 'electron';
import reportFixture from '../fixtures/classroom-report.json';

vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof Vue>()),
  onMounted: vi.fn(),
  onUnmounted: vi.fn(),
  useSSRContext: () => ({ modules: new Set() }),
}));

const scopes: ReturnType<typeof effectScope>[] = [];

afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LLM automation settings', () => {
  it('labels the selected classroom with both its name and full id', async () => {
    const { panel } = setupPanel({});
    panel.lessons.value = [
      {
        id: '1785336445811421568',
        title: '2026秋-深度学习-0',
        status: 'active',
      },
    ];
    panel.selectedLessonId.value = '1785336445811421568';
    await nextTick();

    expect(panel.selectedLessonLabel.value).toBe(
      '2026秋-深度学习-0 · ID：1785336445811421568',
    );
  });

  it.each(['queued', 'generating'])(
    'cancels the old classroom automatic answer when it ends while %s, with notifications disabled',
    async (phase) => {
      const { panel, api, problem } = setupPanel({
        llmAutoGenerate: true,
        llmManagedSubmit: true,
      });
      panel.connectedLessonIds.add(problem.lessonId);
      const generate = api.generateAnswerProposal.getMockImplementation()!;
      const finish = async () => {
        api.listLessons.mockResolvedValue([
          { id: problem.lessonId, title: 'Old', status: 'ended' },
        ] as never);
        await panel.handleClassroomNotice({
          kind: 'lesson-finished',
          lessonId: problem.lessonId,
          dedupeKey: 'finished',
          occurredAt: Date.now(),
          title: 'Ended',
          detail: '',
        });
      };
      if (phase === 'generating') {
        api.generateAnswerProposal.mockImplementation(async (input) => {
          await finish();
          return generate(input);
        });
      }
      await panel.automationTick();
      expect(panel.scheduledProblems.size).toBe(1);
      if (phase === 'queued') await finish();
      await vi.runAllTimersAsync();
      expect(panel.connectedLessonIds.has(problem.lessonId)).toBe(false);
      expect(panel.scheduledProblems.size).toBe(0);
      expect(api.submitAnswer).not.toHaveBeenCalled();
      expect(api.generateAnswerProposal).toHaveBeenCalledTimes(
        phase === 'queued' ? 0 : 1,
      );
    },
  );

  it.each(['success', 'rejected', 'not-accepted'])(
    'uses the official review exercises through panel, AI and retry submission: %s',
    async (outcome) => {
      const { panel, props } = setupPanel({
        llmAutoGenerate: true,
        llmManagedSubmit: true,
      });
      const collector = new BrowserLessonCollector();
      const requests: ActiveHttpRequest[] = [];
      const client = new YuketangActiveClient({
        browserCollector: collector,
        credentials: {
          load: async () => ({
            cookieHeader: '',
            bearerToken: 'fixture',
            userId: 'fixture',
          }),
        },
        transport: {
          request: async (request) => {
            requests.push(request);
            expect(request.url).toBe(
              'https://www.yuketang.cn/api/v3/lesson/problem/retry',
            );
            const id = JSON.parse(request.body!).problems[0].problemId;
            return {
              status: 200,
              headers: {},
              body:
                outcome === 'rejected'
                  ? { code: 50004, msg: '课堂已结束' }
                  : {
                      code: 0,
                      data: { success: outcome === 'success' ? [id] : [] },
                    },
            };
          },
        },
      });
      const provider: AiProviderPlugin = {
        id: 'review-fixture',
        discoverModels: async () => [
          {
            id: 'vision',
            name: 'Vision',
            ownedBy: 'fixture',
            created: null,
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            supportedParameters: [],
            contextWindow: 32000,
            outputLimit: 2000,
          },
        ],
        complete: vi.fn(async () =>
          JSON.stringify({
            answer: 'B',
            explanation: 'Fixture',
            confidence: 0.9,
            failureReason: null,
          }),
        ),
      };
      const runtime = createBackendRuntime({
        activeClient: client,
        aiProviders: [provider],
      });
      await runtime.start();
      try {
        const facade = runtime.facade;
        await facade.connectAiProfile({
          providerId: provider.id,
          baseUrl: 'https://fixture.example/v1',
          apiKey: 'fixture-key',
        });
        panel.applySettings(
          await facade.updateSettings({
            llmAutoGenerate: true,
            llmManagedSubmit: true,
            autoAnswerDelay: 1000,
            autoAnswerRandomDelay: 0,
            notifyProblems: false,
          }),
        );
        const generate = vi.fn(facade.generateAnswerProposal.bind(facade));
        vi.stubGlobal('window', {
          yuketang: {
            listLessons: facade.listLessons.bind(facade),
            listProblems: facade.listProblems.bind(facade),
            listPresentations: facade.listPresentations.bind(facade),
            getLessonCollectionStatus: async (id: string) =>
              collector.getCollectionStatus(id),
            generateAnswerProposal: generate,
            submitAnswer: facade.submitAnswer.bind(facade),
            logAutomation: (input: AutomationLogInput) =>
              recordAutomationLog(runtime.dataStore, input),
          },
        });
        const lessonId = reportFixture.lessonId;
        // A different classroom was selected before navigation. No connect or
        // WebSocket event is required to discover this ended classroom.
        props.browserUrl = `https://www.yuketang.cn/v2/web/student-lesson-report/1/${lessonId}/2`;
        await nextTick();
        expect(panel.problems.value).toEqual([]);
        for (const [endpoint, body] of [
          ['student/review', reportFixture.review],
          ['student/detail', reportFixture.detail],
          ['student/lesson-info', reportFixture.lessonInfo],
        ] as const) {
          await collector.observeHttp({
            method: 'GET',
            url: `https://www.yuketang.cn/api/v3/classroom-report/${endpoint}?lesson_id=${lessonId}`,
            contextId: 'report-tab',
            statusCode: 200,
            body: JSON.stringify(body),
          });
        }
        // Mark one as already answered via another report observation. Empty
        // result arrays on the remaining real records are NOT answered.
        const answered = structuredClone(reportFixture.detail);
        answered.data.problem.studentList[4]!.isAnswered = true;
        (answered.data.problem.studentList[4]!.result as string[]).push('A');
        await collector.observeHttp({
          url: `https://www.yuketang.cn/api/v3/classroom-report/student/detail?lesson_id=${lessonId}`,
          contextId: 'report-tab',
          statusCode: 200,
          body: JSON.stringify(answered),
        });
        expect(await facade.listProblems(lessonId)).toHaveLength(5);
        await panel.automationTick();
        const expected = reportFixture.detail.data.problem.studentList;
        expect(panel.selectedLessonId.value).toBe(lessonId);
        expect(panel.selectedLesson.value.title).toBe('课堂回顾回归样例');
        expect(panel.problems.value.map((p: ProblemContext) => p.id)).toEqual(
          expected.map((p) => p.problemId),
        );
        expect(panel.selectedProblemId.value).toBe(expected[0]!.problemId);
        expect(panel.selectedProblemImage.value).toBe(expected[0]!.cover);
        expect(panel.problems.value[0]).toMatchObject({
          status: 'expired',
          result: null,
          source: 'classroom-report',
          unlockedAt: expected[0]!.send_time,
        });
        expect([...panel.connectedLessonIds]).toEqual([]);
        await vi.runAllTimersAsync();
        expect(generate).toHaveBeenCalledTimes(4);
        expect(requests).toHaveLength(4);
        for (const problem of expected.slice(0, 4)) {
          expect(generate).toHaveBeenCalledWith(
            expect.objectContaining({
              problemId: problem.problemId,
              imageUrls: [problem.cover],
              captureCurrentPage: false,
            }),
          );
          expect(
            requests.some((r) => {
              const item = JSON.parse(r.body!).problems[0];
              return (
                item.problemId === problem.problemId &&
                item.dt === problem.send_time + 2000
              );
            }),
          ).toBe(true);
        }
        const actual = await facade.listProblems(lessonId);
        expect(actual.filter((p) => p.status === 'answered')).toHaveLength(
          outcome === 'success' ? 5 : 1,
        );
        await panel.automationTick();
        await vi.runAllTimersAsync();
        expect(requests).toHaveLength(4);
      } finally {
        await runtime.stop();
      }
    },
  );

  it('cancels queued review answers when the browser switches classrooms', async () => {
    const { panel, props, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    const review: ProblemContext = {
      ...problem,
      source: 'classroom-report',
      status: 'expired',
    };
    api.listProblems.mockResolvedValue([review]);
    props.browserUrl = `https://www.yuketang.cn/v2/web/student-lesson-report/1/${problem.lessonId}/2`;
    await nextTick();
    await panel.automationTick();
    props.browserUrl =
      'https://www.yuketang.cn/v2/web/student-lesson-report/1/another-lesson/2';
    await nextTick();
    await vi.runAllTimersAsync();
    expect(api.generateAnswerProposal).not.toHaveBeenCalled();
    expect(api.submitAnswer).not.toHaveBeenCalled();
    props.browserUrl = `https://www.yuketang.cn/v2/web/student-lesson-report/1/${problem.lessonId}/2`;
    await nextTick();
    await panel.automationTick();
    await vi.runAllTimersAsync();
    expect(api.generateAnswerProposal).toHaveBeenCalledTimes(1);
    expect(api.submitAnswer).toHaveBeenCalledTimes(1);
  });

  it('keeps late live answers eligible for the backend retry route, but skips an answer already submitted on the page', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    const generate = api.generateAnswerProposal.getMockImplementation()!;
    api.listLessons.mockResolvedValue([
      { id: problem.lessonId, title: 'Active lesson', status: 'active' },
    ]);
    api.generateAnswerProposal.mockImplementation(async (input) => {
      api.listProblems.mockResolvedValue([
        { ...problem, status: 'expired', deadlineAt: Date.now() - 1 },
      ]);
      return generate(input);
    });
    panel.connectedLessonIds.add(problem.lessonId);
    await panel.automationTick();
    await vi.runAllTimersAsync();
    expect(api.submitAnswer).toHaveBeenCalledTimes(1);

    api.submitAnswer.mockClear();
    api.listProblems.mockResolvedValue([problem]);
    api.generateAnswerProposal.mockImplementation(async (input) => {
      api.listProblems.mockResolvedValue([
        { ...problem, status: 'answered', result: ['B'] },
      ]);
      return generate(input);
    });
    panel.seenAvailableProblems.clear();
    await panel.automationTick();
    await vi.runAllTimersAsync();
    expect(api.submitAnswer).not.toHaveBeenCalled();
  });

  it('auto-joins and answers both concurrent lessons without changing the displayed lesson', async () => {
    const { panel, api, problem } = setupPanel({
      autoJoinEnabled: true,
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    const other = {
      ...problem,
      id: 'problem-2',
      lessonId: 'lesson-2',
      presentationId: 'presentation-2',
      slideId: 'slide-2',
    };
    const lessonProblems = new Map([
      [problem.lessonId, [problem]],
      [other.lessonId, [other]],
    ]);
    api.refreshLessons.mockResolvedValue([
      { id: problem.lessonId, title: 'First', status: 'active' },
      { id: other.lessonId, title: 'Second', status: 'active' },
    ]);
    api.listProblems.mockImplementation(
      async (id) => lessonProblems.get(id) ?? [],
    );
    api.listPresentations.mockImplementation(async (id) => {
      const current = lessonProblems.get(id)![0]!;
      return [
        {
          id: current.presentationId,
          lessonId: id,
          title: id,
          width: null,
          height: null,
          slides: [
            {
              id: current.slideId,
              index: 1,
              title: id,
              imageUrl: `https://example.com/${id}.png`,
              problem: null,
            },
          ],
        },
      ];
    });

    await panel.automationTick();
    await vi.runAllTimersAsync();
    await panel.automationTick();
    await vi.runAllTimersAsync();

    expect(api.connectLesson.mock.calls.map(([, id]) => id)).toEqual([
      'lesson-1',
      'lesson-2',
    ]);
    expect(
      api.generateAnswerProposal.mock.calls
        .map(([input]) => input.problemId)
        .sort(),
    ).toEqual(['problem-1', 'problem-2']);
    for (const current of [problem, other]) {
      expect(api.generateAnswerProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          problemId: current.id,
          imageUrls: [`https://example.com/${current.lessonId}.png`],
          captureCurrentPage: false,
        }),
      );
      expect(api.submitAnswer).toHaveBeenCalledWith(
        expect.objectContaining({
          problemId: current.id,
          confirmedBy: 'agent',
        }),
      );
    }
    expect(api.submitAnswer).toHaveBeenCalledTimes(2);
    expect(panel.selectedLessonId.value).toBe(problem.lessonId);
    expect(panel.selectedProblemId.value).toBe(problem.id);
  });

  it.each([
    'success',
    'second-lesson-after-ended',
    'second-lesson-after-missed-end',
    'ended-before-submit',
    'submit-http-error',
    'refresh-http-error',
    'transport-error',
    'lesson-ended',
    'browser-rotated-auth',
  ])(
    'traces browser publications through automatic submissions: %s',
    async (scenario) => {
      const { panel } = setupPanel({
        autoJoinEnabled: true,
        llmAutoGenerate: true,
        llmManagedSubmit: true,
      });
      const collector = new BrowserLessonCollector();
      const unwatch = vi.spyOn(collector, 'unwatchLesson');
      const submissions: ActiveHttpRequest[] = [];
      const checkins: ActiveHttpRequest[] = [];
      let pageAuthorization = 'fixture';
      const expectedSuccess =
        scenario === 'success' ||
        scenario === 'browser-rotated-auth' ||
        scenario.startsWith('second-lesson-');
      const sequential = scenario.startsWith('second-lesson-');
      const remoteLessons = [
        { lessonId: 7, presentationId: 9, title: 'First', status: 1 },
        { lessonId: 17, presentationId: 19, title: 'Second', status: 1 },
      ];
      let visibleLessons = sequential
        ? remoteLessons.slice(0, 1)
        : remoteLessons;
      const client = new YuketangActiveClient({
        credentials: new ElectronSessionCredentialSource(
          () =>
            ({
              getURL: () =>
                'https://www.yuketang.cn/lesson/fullscreen/v3/7/ppt/1',
              executeJavaScript: async () => pageAuthorization,
              session: {
                cookies: {
                  get: async () => [{ name: 'user_id', value: '42' }],
                },
              },
            }) as unknown as WebContents,
          new MemorySecretStore(),
        ),
        browserCollector: collector,
        socketFactory: () => {
          throw new Error('Browser collection must use official page sockets');
        },
        transport: {
          async request(request) {
            if (request.url.endsWith('/classroom/on-lesson')) {
              return {
                status: 200,
                headers: {},
                // Real on-lesson records need not contain a presentation ID.
                // Matching only that ID worked for one lesson but lost all
                // deck responses as soon as another lesson was watched.
                body: {
                  data: {
                    onLessonClassrooms: visibleLessons.map(
                      ({ lessonId, title, status }) => ({
                        lessonId,
                        title,
                        status,
                      }),
                    ),
                  },
                },
              };
            }
            if (request.url.endsWith('/problem/answer')) {
              submissions.push(request);
              if (
                scenario === 'browser-rotated-auth' &&
                request.headers.authorization !==
                  'Bearer rotated-by-official-page'
              ) {
                return {
                  status: 401,
                  headers: {},
                  body: { msg: 'Stale authorization' },
                };
              }
              if (scenario === 'lesson-ended')
                return {
                  status: 200,
                  headers: {},
                  body: { code: 50004, msg: '已经下课了。' },
                };
              if (scenario === 'transport-error')
                throw new Error('Connection reset');
              if (scenario === 'submit-http-error')
                return {
                  status: 400,
                  headers: {},
                  body: { code: 40001, msg: 'Invalid submission' },
                };
              if (scenario === 'refresh-http-error')
                return {
                  status: 401,
                  headers: {},
                  body: { msg: 'Expired credential' },
                };
              return { status: 200, headers: {}, body: { code: 0 } };
            }
            if (request.url.endsWith('/lesson/checkin')) {
              checkins.push(request);
              return {
                status: 400,
                headers: {},
                body: {
                  code: 40002,
                  msg: 'Checkin rejected; token=secret-value',
                },
              };
            }
            throw new Error(`Unexpected request: ${request.url}`);
          },
        },
      });
      const provider: AiProviderPlugin = {
        id: 'fixture',
        discoverModels: async () => [
          {
            id: 'fixture-model',
            name: 'Fixture',
            ownedBy: 'fixture',
            created: null,
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportedParameters: [],
            contextWindow: 32000,
            outputLimit: 2000,
          },
        ],
        complete: async () =>
          JSON.stringify({
            answer: 'A',
            explanation: 'Fixture answer',
            confidence: 0.9,
            failureReason: null,
          }),
      };
      const runtime = createBackendRuntime({
        activeClient: client,
        aiProviders: [provider],
      });
      await runtime.start();
      try {
        const facade = runtime.facade;
        await facade.connectAiProfile({
          providerId: provider.id,
          baseUrl: 'https://fixture.example/v1',
          apiKey: 'fixture-key',
        });
        panel.applySettings(
          await facade.updateSettings({
            autoJoinEnabled: true,
            llmAutoGenerate: true,
            llmManagedSubmit: true,
            autoAnswerDelay: 1000,
            autoAnswerRandomDelay: 0,
            notifyProblems: false,
          }),
        );
        // These are the same facade calls as the desktop IPC handlers. All external I/O is fake.
        vi.stubGlobal('window', {
          yuketang: {
            refreshLessons: facade.refreshLessons.bind(facade),
            listLessons: facade.listLessons.bind(facade),
            connectLesson: facade.connectLesson.bind(facade),
            listProblems: facade.listProblems.bind(facade),
            listPresentations: facade.listPresentations.bind(facade),
            getLessonCollectionStatus: async (id: string) =>
              collector.getCollectionStatus(id),
            generateAnswerProposal: facade.generateAnswerProposal.bind(facade),
            validateAnswer: facade.validateAnswer.bind(facade),
            submitAnswer: facade.submitAnswer.bind(facade),
            logAutomation: async (input: AutomationLogInput) => {
              await recordAutomationLog(runtime.dataStore, input);
              if (
                scenario === 'ended-before-submit' &&
                input.stage === 'submit-started'
              ) {
                await collector.observeWebSocket({
                  requestId: `socket-${input.lessonId}`,
                  direction: 'received',
                  payload: JSON.stringify({ op: 'lessonfinished' }),
                });
              }
            },
          },
        });
        panel.selectedLessonId.value = '7';
        await panel.automationTick();
        expect([...panel.connectedLessonIds]).toEqual(
          sequential ? ['7'] : ['7', '17'],
        );
        // Official classroom responses write a new Authorization to localStorage
        // after the initial on-lesson request populated the backend cache.
        if (scenario === 'browser-rotated-auth')
          pageAuthorization = 'rotated-by-official-page';

        for (const lesson of remoteLessons) {
          if (sequential && lesson.lessonId === 17) {
            visibleLessons = remoteLessons.slice(1);
            await vi.advanceTimersByTimeAsync(5000);
            await panel.automationTick();
            expect([...panel.connectedLessonIds]).toEqual(['17']);
            expect(unwatch).toHaveBeenCalledWith('7');
            expect(await facade.listLessons()).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ id: '7', status: 'ended' }),
                expect.objectContaining({ id: '17', status: 'active' }),
              ]),
            );
          }
          const problemId = lesson.presentationId + 2;
          const slideId = lesson.presentationId + 1;
          await collector.observeWebSocket({
            requestId: `socket-${lesson.lessonId}`,
            direction: 'sent',
            payload: JSON.stringify({ op: 'hello', lessonid: lesson.lessonId }),
          });
          // The publication can arrive before the asynchronous deck body.
          await collector.observeWebSocket({
            requestId: `socket-${lesson.lessonId}`,
            direction: 'received',
            payload: JSON.stringify({
              op: 'unlockproblem',
              problem: {
                problemId,
                pres: lesson.presentationId,
                slideId,
                dt: Date.now(),
                limit: 60,
              },
            }),
          });
          await collector.observeHttp({
            url: `https://www.yuketang.cn/api/v3/lesson/presentation/fetch?presentation_id=${lesson.presentationId}`,
            pageUrl: `https://www.yuketang.cn/lesson/fullscreen/v3/${lesson.lessonId}/ppt/1`,
            statusCode: 200,
            body: JSON.stringify({
              data: {
                id: lesson.presentationId,
                title: lesson.title,
                slides: [
                  {
                    id: slideId,
                    problem: {
                      problemId,
                      problemType: 1,
                      content: lesson.title,
                      options: ['One', 'Two'],
                    },
                  },
                ],
              },
            }),
          });
          await collector.observeWebSocket({
            requestId: `socket-${lesson.lessonId}`,
            direction: 'received',
            payload: JSON.stringify({
              op: 'unlockproblem',
              problem: {
                problemId,
                pres: lesson.presentationId,
                slideId,
                dt: Date.now(),
                limit: 60,
              },
            }),
          });
          if (sequential && lesson.lessonId === 7) {
            await panel.automationTick();
            await vi.advanceTimersByTimeAsync(1000);
            if (scenario === 'second-lesson-after-ended') {
              await collector.observeWebSocket({
                requestId: 'socket-7',
                direction: 'received',
                payload: JSON.stringify({ op: 'lessonfinished' }),
              });
            } else {
              // The old tab closes before it can receive lessonfinished.
              await collector.observeWebSocket({
                requestId: 'socket-7',
                direction: 'closed',
                payload: null,
              });
            }
          }
        }
        await panel.automationTick();
        await vi.advanceTimersByTimeAsync(1000);

        if (scenario === 'ended-before-submit') {
          expect(submissions).toHaveLength(0);
          expect(checkins).toHaveLength(0);
          expect(
            (await facade.listLessons()).every(
              (lesson) => lesson.status === 'ended',
            ),
          ).toBe(true);
          const logs = await facade.listLogs(200);
          expect(
            logs.filter(
              (log) =>
                log.scope === 'answer-request' &&
                log.details?.stage === 'submit-failed',
            ),
          ).toHaveLength(2);
          expect(JSON.stringify(logs)).toContain('课堂已结束，已取消自动提交');
          return;
        }

        expect(
          submissions
            .map((request) => JSON.parse(request.body!).problemId)
            .sort(),
        ).toEqual(['11', '21']);
        const logs = await facade.listLogs(200);
        for (const problemId of ['11', '21']) {
          const workflow = logs
            .filter(
              (log) =>
                log.scope === 'automation' &&
                (log.details as Record<string, unknown>)?.problemId ===
                  problemId,
            )
            .reverse();
          expect(
            workflow.map(
              (log) => (log.details as Record<string, unknown>).stage,
            ),
          ).toEqual([
            'scheduled',
            'started',
            'generated',
            'submit-started',
            expectedSuccess ? 'submitted' : 'failed',
          ]);
        }
        if (!expectedSuccess) {
          const requestFailures = logs.filter(
            (log) =>
              log.scope === 'answer-request' &&
              (log.details as Record<string, unknown>)?.stage ===
                'submit-failed',
          );
          expect(requestFailures).toHaveLength(2);
          expect(requestFailures[0]?.details).toMatchObject({
            endpoint: 'https://www.yuketang.cn/api/v3/lesson/problem/answer',
            method: 'POST',
            confirmedBy: 'agent',
            route: 'answer',
            attempt: 1,
            httpStatus:
              scenario === 'transport-error'
                ? null
                : scenario === 'submit-http-error'
                  ? 400
                  : scenario === 'refresh-http-error'
                    ? 401
                    : 200,
            remainingMs: 59000,
            willRefresh: scenario === 'refresh-http-error',
          });
          if (scenario === 'refresh-http-error') {
            expect(checkins).toHaveLength(2);
            expect(JSON.parse(checkins[0]!.body!)).toMatchObject({ source: 1 });
            expect(logs).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  scope: 'answer-request',
                  details: expect.objectContaining({
                    stage: 'credential-refresh-failed',
                    endpoint: 'https://www.yuketang.cn/api/v3/lesson/checkin',
                    httpStatus: 400,
                    businessCode: 40002,
                    serverMessage: 'Checkin rejected; token=[REDACTED]',
                  }),
                }),
              ]),
            );
          }
          if (scenario === 'lesson-ended') {
            expect(checkins).toHaveLength(0);
            expect(requestFailures[0]?.details).toMatchObject({
              businessCode: 50004,
              serverMessage: '已经下课了。',
            });
            const finalFailure = logs.find(
              (log) => log.scope === 'answer' && log.level === 'error',
            );
            expect(
              (finalFailure?.details as Record<string, unknown>).error,
            ).toContain('课堂已结束');
            expect(
              (finalFailure?.details as Record<string, unknown>).error,
            ).not.toContain('HTTP 400');
          }
          expect(JSON.stringify(logs)).not.toContain('secret-value');
          expect(await facade.getProblem('11')).toMatchObject({
            status: 'available',
            result: null,
          });
          await panel.automationTick();
          await vi.advanceTimersByTimeAsync(60000);
          await panel.automationTick();
          expect(submissions).toHaveLength(2);
          expect(await facade.getProblem('11')).toMatchObject({
            status: 'expired',
            result: null,
          });
          return;
        }
        expect(await facade.getProblem('11')).toMatchObject({
          lessonId: '7',
          status: 'answered',
        });
        expect(await facade.getProblem('21')).toMatchObject({
          lessonId: '17',
          status: 'answered',
        });
        expect(panel.selectedLessonId.value).toBe(sequential ? '17' : '7');
        expect(checkins).toHaveLength(0);
      } finally {
        await runtime.stop();
      }
    },
  );

  it('keeps a scheduled answer bound to its lesson when the user switches lessons', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    panel.connectedLessonIds.add(problem.lessonId);
    await panel.automationTick();
    panel.selectedLessonId.value = 'another-lesson';
    panel.selectedProblemId.value = '';
    panel.problems.value = [];
    api.listProblems.mockImplementation(async (id) =>
      id === problem.lessonId ? [problem] : [],
    );

    await vi.runAllTimersAsync();

    expect(api.submitAnswer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ problemId: problem.id }),
    );
    expect(panel.selectedLessonId.value).toBe('another-lesson');
    expect(panel.selectedProblemId.value).toBe('');
  });

  it('rechecks the source lesson before answering a delayed problem', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    panel.connectedLessonIds.add(problem.lessonId);
    await panel.automationTick();
    api.listProblems.mockResolvedValue([{ ...problem, status: 'answered' }]);

    await vi.runAllTimersAsync();

    expect(api.generateAnswerProposal).not.toHaveBeenCalled();
    expect(api.submitAnswer).not.toHaveBeenCalled();
    expect(api.logAutomation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'skipped',
        reason: 'problem-answered',
        problemId: problem.id,
      }),
    );
  });

  it('logs insufficient time once even with notifications disabled', async () => {
    const { panel, api, problem } = setupPanel({ llmAutoGenerate: true });
    problem.deadlineAt = Date.now() + 500;
    panel.connectedLessonIds.add(problem.lessonId);
    await panel.automationTick();
    await panel.automationTick();
    await vi.runAllTimersAsync();
    expect(api.logAutomation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        stage: 'skipped',
        reason: 'insufficient-time-before-deadline',
        remainingMs: 500,
        delayMs: 1000,
      }),
    );
    expect(api.generateAnswerProposal).not.toHaveBeenCalled();
  });

  it('keeps automatic submission working if diagnostic persistence fails', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    api.logAutomation.mockRejectedValue(new Error('Disk full'));
    panel.connectedLessonIds.add(problem.lessonId);
    await panel.automationTick();
    await vi.runAllTimersAsync();
    expect(api.submitAnswer).toHaveBeenCalledOnce();
  });

  it('continues polling other lessons when one lesson cannot be read', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    panel.connectedLessonIds.add('unavailable-lesson');
    panel.connectedLessonIds.add(problem.lessonId);
    panel.selectedLessonId.value = 'unavailable-lesson';
    api.listProblems.mockImplementation(async (id) => {
      if (id === 'unavailable-lesson') throw new Error('Unable to read lesson');
      return [problem];
    });

    await panel.automationTick();
    await vi.runAllTimersAsync();

    expect(api.submitAnswer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ problemId: problem.id }),
    );
  });

  it('runs the complete generation and managed submission flow', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
      aiAnalyzeLatestOnOpen: true,
    });

    await panel.onAvailableProblem(problem);
    await vi.runAllTimersAsync();

    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
    expect(api.validateAnswer).not.toHaveBeenCalled();
    expect(api.submitAnswer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        problemId: problem.id,
        confirmedBy: 'agent',
      }),
    );
  });

  it('generates and submits each queued question once when their timers fire together', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    const second = { ...problem, id: 'problem-2', slideId: 'slide-2' };
    panel.problems.value = [problem, second];
    api.listProblems.mockImplementation(async () => panel.problems.value);
    await Promise.all([
      panel.onAvailableProblem(problem),
      panel.onAvailableProblem(second),
    ]);
    await vi.runAllTimersAsync();
    expect(
      api.generateAnswerProposal.mock.calls.map(([input]) => input.problemId),
    ).toEqual([problem.id, second.id]);
    expect(
      api.submitAnswer.mock.calls.map(([input]) => input.problemId),
    ).toEqual([problem.id, second.id]);
  });

  it('keeps each question result when two model requests finish in reverse order', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    const second = { ...problem, id: 'problem-2', slideId: 'slide-2' };
    const proposals = [
      await api.generateAnswerProposal({ problemId: problem.id }),
      await api.generateAnswerProposal({ problemId: second.id }),
    ];
    const pending = new Map<string, (proposal: AnswerProposal) => void>();
    api.generateAnswerProposal
      .mockClear()
      .mockImplementation(
        ({ problemId }) =>
          new Promise((resolve) => pending.set(problemId, resolve)),
      );
    panel.problems.value = [problem, second];
    api.listProblems.mockImplementation(async () => panel.problems.value);
    await Promise.all([
      panel.onAvailableProblem(problem),
      panel.onAvailableProblem(second),
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.generateAnswerProposal).toHaveBeenCalledTimes(2);
    pending.get(second.id)!(proposals[1]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      panel.problems.value.find((item: ProblemContext) => item.id === second.id)
        .status,
    ).toBe('answered');
    pending.get(problem.id)!(proposals[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      api.submitAnswer.mock.calls.map(([input]) => input.problemId),
    ).toEqual([second.id, problem.id]);
    expect(
      panel.problems.value.every(
        (item: ProblemContext) => item.status === 'answered',
      ),
    ).toBe(true);
  });

  it('does not let an older poll overwrite the state refreshed after submission', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    let finish!: (value: ProblemContext[]) => void;
    api.listProblems.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oldPoll = panel.loadLessonData();
    const answered: ProblemContext = {
      ...problem,
      result: ['A'],
      status: 'answered',
    };
    api.listProblems.mockResolvedValueOnce([problem]);
    api.listProblems.mockResolvedValueOnce([answered]);
    await panel.applyAutomaticProposal(
      problem,
      await api.generateAnswerProposal({ problemId: problem.id }),
    );
    expect(panel.problems.value[0].status).toBe('answered');
    finish([problem]);
    await oldPoll;
    expect(panel.problems.value[0].status).toBe('answered');
  });

  it('keeps a successful submission answered even when refreshing presentations fails', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    api.listPresentations.mockRejectedValueOnce(
      new Error('presentation unavailable'),
    );
    api.listProblems.mockResolvedValueOnce([problem]);
    api.listProblems.mockResolvedValueOnce([
      { ...problem, result: ['A'], status: 'answered' },
    ]);
    await panel.applyAutomaticProposal(
      problem,
      await api.generateAnswerProposal({ problemId: problem.id }),
    );
    expect(panel.problems.value[0].status).toBe('answered');
  });

  it('continues with the next question after a successful POST and failed problem refresh', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    api.listProblems.mockResolvedValueOnce([problem]);
    api.listProblems.mockResolvedValueOnce([problem]);
    api.listProblems.mockRejectedValueOnce(new Error('refresh unavailable'));
    await panel.onAvailableProblem(problem);
    await vi.runAllTimersAsync();
    expect(panel.problems.value[0]).toMatchObject({
      status: 'answered',
      result: ['A'],
    });
    const second = { ...problem, id: 'problem-2', slideId: 'slide-2' };
    panel.problems.value.push(second);
    api.listProblems.mockImplementation(async () => panel.problems.value);
    await panel.onAvailableProblem(second);
    await vi.runAllTimersAsync();
    expect(
      api.submitAnswer.mock.calls.map(([input]) => input.problemId),
    ).toEqual([problem.id, second.id]);
    expect(
      panel.problems.value.every(
        (item: ProblemContext) => item.status === 'answered',
      ),
    ).toBe(true);
  });

  it('handles a rejected submission without blocking the next question', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    api.submitAnswer.mockRejectedValueOnce(new Error('server rejected answer'));
    await panel.onAvailableProblem(problem);
    await vi.runAllTimersAsync();
    expect(panel.errorMessage.value).toContain('server rejected answer');
    expect(panel.problems.value[0].status).toBe('available');
    const second = { ...problem, id: 'problem-2', slideId: 'slide-2' };
    panel.problems.value.push(second);
    api.listProblems.mockImplementation(async () => panel.problems.value);
    await panel.onAvailableProblem(second);
    await vi.runAllTimersAsync();
    expect(api.submitAnswer).toHaveBeenCalledTimes(2);
    expect(
      panel.problems.value.find((item: ProblemContext) => item.id === second.id)
        .status,
    ).toBe('answered');
  });

  it('does not post a late model response after moving to another classroom or answering elsewhere', async () => {
    for (const change of ['classroom', 'answered']) {
      const { panel, api, problem } = setupPanel({
        llmAutoGenerate: true,
        llmManagedSubmit: true,
      });
      panel.selectedProblemId.value = problem.id;
      await nextTick();
      const proposal = await api.generateAnswerProposal({
        problemId: problem.id,
      });
      let finish!: (value: AnswerProposal) => void;
      api.generateAnswerProposal.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = panel.analyzeProblem(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.generateAnswerProposal).toHaveBeenCalledTimes(2);
      if (change === 'classroom')
        panel.selectedLessonId.value = 'another-classroom';
      else
        panel.problems.value = [
          { ...problem, status: 'answered', result: ['B'] },
        ];
      finish(proposal);
      await pending;
      expect(api.submitAnswer).not.toHaveBeenCalled();
    }
  });

  it('ignores an old classroom response after switching classrooms', async () => {
    const { panel, api, problem } = setupPanel({});
    let finish!: (value: ProblemContext[]) => void;
    api.listProblems.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = panel.loadLessonData();
    const next = {
      ...problem,
      id: 'other-problem',
      lessonId: 'another-classroom',
    };
    panel.selectedLessonId.value = next.lessonId;
    api.listProblems.mockResolvedValueOnce([next]);
    await panel.loadLessonData();
    finish([problem]);
    await pending;
    expect(panel.problems.value).toEqual([next]);
  });

  it('does not clear the next classroom draft when an earlier POST finishes late', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    const proposal = await api.generateAnswerProposal({
      problemId: problem.id,
    });
    let finish!: (value: Awaited<ReturnType<typeof api.submitAnswer>>) => void;
    api.submitAnswer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = panel.applyAutomaticProposal(problem, proposal);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.submitAnswer).toHaveBeenCalledOnce();
    const next = {
      ...problem,
      id: 'other-problem',
      lessonId: 'other-classroom',
    };
    panel.selectedLessonId.value = next.lessonId;
    panel.problems.value = [next];
    panel.selectedProblemId.value = next.id;
    await nextTick();
    panel.confirmed.value = true;
    panel.appliedProposalId.value = 'next-proposal';
    finish({
      problemId: problem.id,
      status: 'submitted',
      route: 'answer',
      submittedAt: new Date().toISOString(),
    });
    await pending;
    expect(panel.problems.value).toEqual([next]);
    expect(panel.confirmed.value).toBe(true);
    expect(panel.appliedProposalId.value).toBe('next-proposal');
    expect(api.listProblems).toHaveBeenCalledExactlyOnceWith(problem.lessonId);
  });

  it('coalesces overlapping automatic submissions for the same question', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    const proposal = await api.generateAnswerProposal({
      problemId: problem.id,
    });
    await Promise.all([
      panel.applyAutomaticProposal(problem, proposal),
      panel.applyAutomaticProposal(problem, proposal),
    ]);
    expect(api.submitAnswer).toHaveBeenCalledOnce();
    expect(panel.problems.value[0].status).toBe('answered');
    await panel.applyAutomaticProposal(problem, proposal);
    expect(api.submitAnswer).toHaveBeenCalledOnce();
  });

  it('can generate an answer without validating or submitting it', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: false,
      llmManagedSubmit: false,
    });

    await panel.onAvailableProblem(problem);
    panel.applySettings({
      ...DefaultAppSettings,
      llmAutoGenerate: true,
      llmManagedSubmit: false,
      autoAnswerDelay: 1000,
      autoAnswerRandomDelay: 0,
      notifyProblems: false,
    });
    await panel.onAvailableProblem(problem);
    await vi.runAllTimersAsync();

    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
    expect(api.validateAnswer).not.toHaveBeenCalled();
    expect(api.submitAnswer).not.toHaveBeenCalled();
    expect(panel.infoMessage.value).toContain('等待手动核对');
  });

  it('selects and analyzes the latest available problem on AI page open', async () => {
    const { panel, api, problem } = setupPanel({
      aiAnalyzeLatestOnOpen: true,
    });
    const latest: ProblemContext = {
      ...problem,
      id: 'problem-latest',
      unlockedAt: 2000,
    };
    panel.problems.value = [problem, latest];

    await panel.analyzeLatestProblemOnOpen();
    await nextTick();

    expect(panel.selectedProblemId.value).toBe(latest.id);
    expect(api.generateAnswerProposal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ problemId: latest.id }),
    );
  });

  it('always sends the problem slide from the problem-page AI entry', async () => {
    const { panel, api, problem, emit } = setupPanel({
      aiCaptureCurrentPage: true,
    });
    const imageUrl = 'https://example.test/problem-slide.png';
    panel.presentations.value = [
      {
        id: problem.presentationId,
        lessonId: problem.lessonId,
        title: '题目课件',
        width: 1920,
        height: 1080,
        slides: [
          {
            id: problem.slideId,
            index: 0,
            title: '题目页',
            imageUrl,
            problem,
          },
        ],
      },
    ];
    panel.selectedProblemId.value = problem.id;
    panel.aiSlideSelection.value = ['unrelated-slide'];
    await nextTick();

    panel.openAiForProblem();
    await panel.analyzeProblem(false);

    expect(emit).toHaveBeenCalledWith('selectPage', 'ai');
    expect(api.generateAnswerProposal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        problemId: problem.id,
        imageUrls: [imageUrl],
        imageSource: 'slide',
        captureCurrentPage: false,
      }),
    );
  });

  it('turns off managed submission when automatic generation is disabled', async () => {
    const { panel } = setupPanel({
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });

    panel.settingsDraft.value.llmAutoGenerate = false;
    await nextTick();

    expect(panel.settingsDraft.value.llmManagedSubmit).toBe(false);
  });

  it('keeps an existing available problem eligible when generation is enabled later', async () => {
    const { panel, api, problem } = setupPanel({
      llmAutoGenerate: false,
    });
    panel.connectedLessonIds.add(problem.lessonId);

    await panel.automationTick();
    expect(api.generateAnswerProposal).not.toHaveBeenCalled();

    panel.applySettings({
      ...DefaultAppSettings,
      llmAutoGenerate: true,
      autoAnswerDelay: 1000,
      autoAnswerRandomDelay: 0,
      notifyProblems: false,
    });
    await panel.automationTick();
    await vi.runAllTimersAsync();

    expect(api.generateAnswerProposal).toHaveBeenCalledOnce();
  });
});

function setupPanel(settings: Record<string, boolean>) {
  vi.useFakeTimers();
  const problem: ProblemContext = {
    id: 'problem-1',
    lessonId: 'lesson-1',
    presentationId: 'presentation-1',
    slideId: 'slide-1',
    type: ProblemType.SingleChoice,
    prompt: '选择正确答案',
    options: ['选项 A', '选项 B'],
    blanks: [],
    result: null,
    status: 'available',
    unlockedAt: 1000,
    deadlineAt: null,
  };
  const proposal: AnswerProposal = {
    id: 'proposal-1',
    sessionId: 'session-1',
    problemId: problem.id,
    status: 'ready',
    answer: ['A'],
    explanation: '选择 A。',
    confidence: 0.9,
    failureReason: null,
    validationIssues: [],
    rawText: '{"answer":["A"]}',
    profileId: 'profile-1',
    model: 'model-1',
    contextSources: [`problem:${problem.id}`],
    createdAt: new Date().toISOString(),
  };
  const api = {
    logAutomation: vi.fn(async (_input: AutomationLogInput) => {}),
    generateAnswerProposal: vi.fn(
      async ({ problemId }: { problemId: string }) => ({
        ...proposal,
        problemId,
      }),
    ),
    validateAnswer: vi.fn(async () => ({
      valid: true,
      issues: [],
      normalizedAnswer: ['A'],
    })),
    submitAnswer: vi.fn(async ({ problemId }: { problemId: string }) => ({
      problemId,
      status: 'submitted',
      route: 'answer',
      submittedAt: new Date().toISOString(),
    })),
    listProblems: vi.fn(
      async (_lessonId: string): Promise<ProblemContext[]> => [problem],
    ),
    listPresentations: vi.fn(
      async (_lessonId: string): Promise<Presentation[]> => [],
    ),
    getLessonCollectionStatus: vi.fn(async () => null),
    refreshLessons: vi.fn(
      async (_environment: BrowserEnvironment): Promise<Lesson[]> => [],
    ),
    listLessons: vi.fn(async () => []),
    connectLesson: vi.fn(
      async (_environment: BrowserEnvironment, _lessonId: string) => {},
    ),
  };
  vi.stubGlobal('window', { yuketang: api });
  const scope = effectScope();
  scopes.push(scope);
  const emit = vi.fn();
  const props = reactive({
    page: 'settings',
    environment: BrowserEnvironment.Standard,
    runtime: undefined,
    browserUrl: undefined,
    collapsed: false,
  });
  const panel = scope.run(() =>
    (AssistantPanel as any).setup(props, { expose: vi.fn(), emit }),
  );
  panel.applySettings({
    ...DefaultAppSettings,
    ...settings,
    autoAnswerDelay: 1000,
    autoAnswerRandomDelay: 0,
    notifyProblems: false,
  });
  panel.problems.value = [problem];
  panel.selectedLessonId.value = problem.lessonId;
  return { panel, api, problem, emit, props };
}

it('prefills assignment extraction in AI without auto-send or leaking classroom/image context', async () => {
  const { panel, api, problem, emit, props } = setupPanel({
    aiAnalyzeLatestOnOpen: true,
    aiCaptureCurrentPage: true,
    llmManagedSubmit: true,
  });
  panel.selectedProblemId.value = problem.id;
  await nextTick();
  const draft = {
    title: '复习试卷',
    text: '请解释：未解码字符𛈒',
    hasEncryptedText: true,
  };
  panel.explainAssignment(draft);
  props.page = 'ai';
  await nextTick();
  expect(emit).toHaveBeenCalledWith('selectPage', 'ai');
  expect(panel.aiCustomPrompt.value).toBe(draft.text);
  expect(api.generateAnswerProposal).not.toHaveBeenCalled();
  panel.aiCustomPrompt.value = '已检查并修改的题干';
  await panel.analyzeProblem(false);
  expect(api.generateAnswerProposal).toHaveBeenCalledWith(
    expect.objectContaining({
      customPrompt: '已检查并修改的题干',
      captureCurrentPage: false,
      imageUrls: [],
      contextId: expect.stringMatching(/^assignment:/),
    }),
  );
  expect(api.generateAnswerProposal.mock.calls[0]![0]).not.toHaveProperty(
    'problemId',
  );
  expect(api.submitAnswer).not.toHaveBeenCalled();
  panel.aiChatDraft.value = '再解释一下';
  await panel.sendAiFollowUp();
  expect(api.generateAnswerProposal).toHaveBeenLastCalledWith(
    expect.objectContaining({
      customPrompt: '再解释一下',
      captureCurrentPage: false,
    }),
  );
  panel.startNewAiChat();
  expect(panel.aiCustomPrompt.value).toBe(draft.text);
});
