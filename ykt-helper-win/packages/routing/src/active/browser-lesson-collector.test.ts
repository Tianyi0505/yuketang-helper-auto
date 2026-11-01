import { BrowserEnvironment, type Presentation } from '@ykt/contracts';
import { describe, expect, it, vi } from 'vitest';

import { BrowserLessonCollector } from './browser-lesson-collector.js';

describe('BrowserLessonCollector tab lifecycle', () => {
  it('stops delivering frames after the classroom tab is released', async () => {
    const collector = new BrowserLessonCollector();
    const listener = vi.fn();
    collector.watchLesson(
      BrowserEnvironment.Standard,
      'lesson-7',
      null,
      listener,
    );
    await collector.observeWebSocket({
      requestId: 'socket-7',
      contextId: 'tab-7',
      direction: 'sent',
      payload: JSON.stringify({ op: 'hello', lessonid: 'lesson-7' }),
    });

    collector.releaseContext('tab-7');
    await collector.observeWebSocket({
      requestId: 'socket-7',
      contextId: 'tab-7',
      direction: 'received',
      payload: JSON.stringify({ op: 'unlockproblem', id: 'problem-1' }),
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps a watched lesson when another tab still carries its socket', async () => {
    const collector = new BrowserLessonCollector();
    const listener = vi.fn();
    collector.watchLesson(
      BrowserEnvironment.Standard,
      'lesson-7',
      null,
      listener,
    );
    for (const contextId of ['tab-a', 'tab-b']) {
      await collector.observeWebSocket({
        requestId: `socket-${contextId}`,
        contextId,
        direction: 'sent',
        payload: JSON.stringify({ op: 'hello', lessonid: 'lesson-7' }),
      });
    }

    collector.releaseContext('tab-a');
    await collector.observeWebSocket({
      requestId: 'socket-tab-b',
      contextId: 'tab-b',
      direction: 'received',
      payload: JSON.stringify({ op: 'unlockproblem', id: 'problem-1' }),
    });

    expect(listener).toHaveBeenCalledWith({
      type: 'message',
      message: { op: 'unlockproblem', id: 'problem-1' },
    });
  });

  it('binds a deck to the lesson named by the requesting page', async () => {
    const collector = new BrowserLessonCollector();
    const first = vi.fn();
    const second = vi.fn();
    collector.watchLesson(
      BrowserEnvironment.Standard,
      'lesson-1',
      'deck-1',
      first,
    );
    collector.watchLesson(
      BrowserEnvironment.Standard,
      'lesson-2',
      null,
      second,
    );

    await collector.observeHttp({
      url: 'https://www.yuketang.cn/api/v3/lesson/presentation/fetch?presentation_id=deck-2',
      pageUrl: 'https://www.yuketang.cn/lesson/fullscreen/v3/lesson-2/ppt/1',
      statusCode: 200,
      body: JSON.stringify({
        data: {
          id: 'deck-2',
          slides: [{ id: 'slide-1', problem: null }],
        },
      }),
    });

    expect(first).not.toHaveBeenCalled();
    const presentation = second.mock.calls[0]?.[0] as {
      presentation: Presentation;
    };
    expect(presentation.presentation.lessonId).toBe('lesson-2');
    expect(presentation.presentation.id).toBe('deck-2');
  });
});
