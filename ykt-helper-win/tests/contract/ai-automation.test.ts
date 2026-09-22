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
} from '@ykt/contracts';
import { createBackendRuntime, type AiProviderPlugin } from '@ykt/backend';
import {
  BrowserLessonCollector,
  YuketangActiveClient,
  type ActiveHttpRequest,
} from '@ykt/routing';
import AssistantPanel from '../../apps/desktop/renderer/src/components/AssistantPanel.vue';

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

  it('routes publications from two browser lessons through the backend to separate submissions', async () => {
    const { panel } = setupPanel({
      autoJoinEnabled: true,
      llmAutoGenerate: true,
      llmManagedSubmit: true,
    });
    const collector = new BrowserLessonCollector();
    const submissions: ActiveHttpRequest[] = [];
    const remoteLessons = [
      { lessonId: 7, presentationId: 9, title: 'First', status: 1 },
      { lessonId: 17, presentationId: 19, title: 'Second', status: 1 },
    ];
    const client = new YuketangActiveClient({
      credentials: {
        load: async () => ({
          cookieHeader: '',
          bearerToken: 'fixture',
          userId: '42',
        }),
      },
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
              body: { data: { onLessonClassrooms: remoteLessons } },
            };
          }
          if (request.url.endsWith('/problem/answer')) {
            submissions.push(request);
            return { status: 200, headers: {}, body: { code: 0 } };
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
          generateAnswerProposal: facade.generateAnswerProposal.bind(facade),
          validateAnswer: facade.validateAnswer.bind(facade),
          submitAnswer: facade.submitAnswer.bind(facade),
        },
      });
      panel.selectedLessonId.value = '7';
      await panel.automationTick();
      expect([...panel.connectedLessonIds]).toEqual(['7', '17']);

      for (const lesson of remoteLessons) {
        const problemId = lesson.presentationId + 2;
        const slideId = lesson.presentationId + 1;
        await collector.observeWebSocket({
          requestId: `socket-${lesson.lessonId}`,
          direction: 'sent',
          payload: JSON.stringify({ op: 'hello', lessonid: lesson.lessonId }),
        });
        await collector.observeHttp({
          url: `https://www.yuketang.cn/api/v3/lesson/presentation/fetch?presentation_id=${lesson.presentationId}`,
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
      }
      await panel.automationTick();
      await vi.advanceTimersByTimeAsync(1000);

      expect(
        submissions
          .map((request) => JSON.parse(request.body!).problemId)
          .sort(),
      ).toEqual(['11', '21']);
      expect(await facade.getProblem('11')).toMatchObject({
        lessonId: '7',
        status: 'answered',
      });
      expect(await facade.getProblem('21')).toMatchObject({
        lessonId: '17',
        status: 'answered',
      });
      expect(panel.selectedLessonId.value).toBe('7');
    } finally {
      await runtime.stop();
    }
  });

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
    submitAnswer: vi.fn(async () => ({
      problemId: problem.id,
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
