import { EventEmitter } from 'node:events';

import { BrowserLessonCollector, NetworkRecorder } from '@ykt/routing';
import { describe, expect, it, vi } from 'vitest';

import { ElectronNetworkObserver } from '../../apps/desktop/main/electron-network-observer.js';
import { DevelopmentNetworkRecorder } from '../../apps/desktop/main/development-network-recorder.js';
import reportFixture from '../fixtures/classroom-report.json';

describe('Electron classroom network observer', () => {
  it('binds sockets per browser tab, preserves an early hello, and releases closed-tab bindings', async () => {
    const collector = new BrowserLessonCollector();
    const first = new FakeContents(1);
    const second = new FakeContents(2);
    const observers = [first, second].map(
      (contents) =>
        new ElectronNetworkObserver(
          contents as never,
          new NetworkRecorder(),
          vi.fn(),
          collector,
          false,
        ),
    );
    await Promise.all(observers.map((observer) => observer.start()));
    const send = (
      contents: FakeContents,
      direction: 'Sent' | 'Received',
      message: unknown,
    ) =>
      contents.debugger.emit(
        'message',
        {},
        `Network.webSocketFrame${direction}`,
        {
          requestId: 'socket-1',
          response: { payloadData: JSON.stringify(message) },
        },
      );
    send(first, 'Sent', { op: 'hello', lessonid: 'old' });
    send(second, 'Sent', { op: 'hello', lessonid: 'new' });
    const oldListener = vi.fn();
    const newListener = vi.fn();
    collector.watchLesson('standard', 'old', null, oldListener);
    collector.watchLesson('standard', 'new', null, newListener);
    send(first, 'Received', { op: 'unlockproblem', problem: 1 });
    send(second, 'Received', { op: 'unlockproblem', problem: 2 });
    expect(oldListener).toHaveBeenCalledWith({
      type: 'message',
      message: { op: 'unlockproblem', problem: 1 },
    });
    expect(newListener).toHaveBeenCalledWith({
      type: 'message',
      message: { op: 'unlockproblem', problem: 2 },
    });
    observers[0]!.destroy();
    send(first, 'Received', { op: 'unlockproblem', problem: 3 });
    send(second, 'Received', { op: 'unlockproblem', problem: 4 });
    expect(oldListener).toHaveBeenCalledTimes(1);
    expect(newListener).toHaveBeenCalledTimes(2);
    observers[1]!.destroy();
  });
  it.each(['review', 'detail', 'lesson-info'] as const)(
    'captures classroom report %s without deep capture',
    async (endpoint) => {
      const collector = new BrowserLessonCollector();
      const listener = vi.fn();
      collector.onArchivedPresentation(listener);
      const contents = new FakeContents();
      const observer = new ElectronNetworkObserver(
        contents as never,
        new NetworkRecorder(),
        vi.fn(),
        collector,
        false,
      );
      await observer.start();
      const body =
        endpoint === 'review'
          ? reportFixture.review
          : endpoint === 'detail'
            ? reportFixture.detail
            : reportFixture.lessonInfo;
      const url = `https://www.yuketang.cn/api/v3/classroom-report/student/${endpoint}?lesson_id=${reportFixture.lessonId}`;
      const observe = vi.spyOn(collector, 'observeHttp');
      contents.debugger.responseBody = JSON.stringify(body);
      contents.debugger.emit('message', {}, 'Network.requestWillBeSent', {
        requestId: 'report',
        request: { url, method: 'GET' },
      });
      contents.debugger.emit('message', {}, 'Network.responseReceived', {
        requestId: 'report',
        type: 'XHR',
        response: { url, status: 200, mimeType: 'application/json' },
      });
      contents.debugger.emit('message', {}, 'Network.loadingFinished', {
        requestId: 'report',
        encodedDataLength: 1000,
      });
      await vi.waitFor(() =>
        expect(observe).toHaveBeenCalledWith(
          expect.objectContaining({ body: JSON.stringify(body) }),
        ),
      );
      if (endpoint !== 'lesson-info') {
        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({
            presentation: expect.objectContaining({
              slides: expect.arrayContaining([
                expect.objectContaining({
                  id: '1900000000000000100',
                  index: 8,
                  problem: expect.objectContaining({
                    id: '1900000000000000100',
                    result: null,
                    source: 'classroom-report',
                  }),
                }),
              ]),
            }),
          }),
        );
      }
    },
  );

  it('does not attach a different deck to the only watched lesson, but allows its own page to switch decks', async () => {
    const collector = new BrowserLessonCollector();
    const listener = vi.fn();
    collector.watchLesson('standard', 'lesson-1', 'deck-1', listener);
    const response = {
      statusCode: 200,
      url: 'https://www.yuketang.cn/api/v3/lesson/presentation/fetch?presentation_id=deck-2',
      body: JSON.stringify({
        data: {
          id: 'deck-2',
          slides: [
            { id: 's', problem: { problemId: 'wrong', problemType: 1 } },
          ],
        },
      }),
    };
    await collector.observeHttp(response);
    await collector.observeHttp({
      ...response,
      pageUrl: 'https://www.yuketang.cn/lesson/fullscreen/v3/lesson-2/ppt/1',
    });
    expect(listener).not.toHaveBeenCalled();
    await collector.observeHttp({
      ...response,
      pageUrl: 'https://www.yuketang.cn/lesson/fullscreen/v3/lesson-1/ppt/1',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the requesting classroom when the page navigates before a deck finishes loading', async () => {
    const collector = new BrowserLessonCollector();
    const oldLesson = vi.fn();
    const newLesson = vi.fn();
    collector.watchLesson('standard', 'old', null, oldLesson);
    collector.watchLesson('standard', 'new', null, newLesson);
    const contents = new FakeContents();
    const observer = new ElectronNetworkObserver(
      contents as never,
      new NetworkRecorder(),
      vi.fn(),
      collector,
      false,
    );
    await observer.start();
    const url =
      'https://www.yuketang.cn/api/v3/lesson/presentation/fetch?presentation_id=deck';
    contents.debugger.responseBody = JSON.stringify({
      data: { id: 'deck', slides: [] },
    });
    contents.debugger.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'deck',
      documentURL: 'https://www.yuketang.cn/lesson/fullscreen/v3/old/ppt/1',
      request: { method: 'GET', url },
    });
    vi.spyOn(contents, 'getURL').mockReturnValue(
      'https://www.yuketang.cn/lesson/fullscreen/v3/new/ppt/1',
    );
    contents.debugger.emit('message', {}, 'Network.responseReceived', {
      requestId: 'deck',
      type: 'XHR',
      response: { url, status: 200, mimeType: 'application/json' },
    });
    contents.debugger.emit('message', {}, 'Network.loadingFinished', {
      requestId: 'deck',
      encodedDataLength: 100,
    });
    await vi.waitFor(() => expect(oldLesson).toHaveBeenCalledTimes(1));
    expect(newLesson).not.toHaveBeenCalled();
  });

  it('streams actual PPT transfer stages and failures without deep capture', async () => {
    const collector = new BrowserLessonCollector();
    const stages: string[] = [];
    collector.onCollectionStatusChanged((status) => stages.push(status.phase));
    collector.watchLesson('standard', 'lesson-1', 'deck-1', vi.fn());
    const contents = new FakeContents();
    const observer = new ElectronNetworkObserver(
      contents as never,
      new NetworkRecorder(),
      vi.fn(),
      collector,
      false,
    );
    await observer.start();
    const url =
      'https://www.yuketang.cn/api/v3/lesson/presentation/fetch?presentation_id=deck-1';
    const emit = (method: string, params: object = {}) =>
      contents.debugger.emit('message', {}, `Network.${method}`, {
        requestId: 'ppt',
        ...params,
      });
    emit('requestWillBeSent', { request: { method: 'GET', url } });
    expect(collector.getCollectionStatus('lesson-1')?.phase).toBe('requesting');
    emit('responseReceived', {
      type: 'XHR',
      response: { url, status: 200, mimeType: 'application/json' },
    });
    emit('dataReceived', { dataLength: 2048 });
    emit('dataReceived', { dataLength: 1024 });
    expect(collector.getCollectionStatus('lesson-1')).toMatchObject({
      phase: 'receiving',
      receivedBytes: 3072,
    });
    contents.debugger.responseBody = JSON.stringify({
      data: { slides: [{ id: 's1', problem: { id: 'p1', type: 1 } }] },
    });
    emit('loadingFinished', { encodedDataLength: 3072 });
    await vi.waitFor(() =>
      expect(collector.getCollectionStatus('lesson-1')).toMatchObject({
        phase: 'ready',
        slideCount: 1,
        problemCount: 1,
      }),
    );
    expect(stages).toContain('parsing');
    emit('requestWillBeSent', { request: { method: 'GET', url } });
    emit('loadingFailed', { errorText: 'net::ERR_TIMED_OUT' });
    expect(collector.getCollectionStatus('lesson-1')).toMatchObject({
      phase: 'network-error',
      detail: 'net::ERR_TIMED_OUT',
      receivedBytes: 0,
    });
    emit('requestWillBeSent', { request: { method: 'GET', url } });
    emit('responseReceived', {
      type: 'XHR',
      response: { url, status: 503, mimeType: 'text/html' },
    });
    emit('dataReceived', { dataLength: 500 });
    expect(collector.getCollectionStatus('lesson-1')).toMatchObject({
      phase: 'network-error',
      detail: 'HTTP 503',
    });
    emit('requestWillBeSent', { request: { method: 'GET', url } });
    emit('responseReceived', {
      type: 'XHR',
      response: { url, status: 200, mimeType: 'application/json' },
    });
    vi.spyOn(contents.debugger, 'sendCommand').mockRejectedValueOnce(
      new Error('Response body evicted'),
    );
    emit('loadingFinished', { encodedDataLength: 100 });
    await vi.waitFor(() =>
      expect(collector.getCollectionStatus('lesson-1')).toMatchObject({
        phase: 'network-error',
        detail: expect.stringContaining('响应读取失败'),
      }),
    );
  });

  it('collects report names and extensionless slides without deep capture', async () => {
    const collector = new BrowserLessonCollector();
    const received = vi.fn();
    collector.onArchivedPresentation(received);
    const contents = new FakeContents();
    const observer = new ElectronNetworkObserver(
      contents as never,
      new NetworkRecorder(),
      vi.fn(),
      collector,
      false,
    );
    await observer.start();
    const responses = [
      { endpoint: 'lesson-info', data: { lessonName: 'lec3-cnn-v3.6' } },
      {
        endpoint: 'review',
        data: {
          timelineList: [
            {
              id: 'slide-1',
              type: 'slide',
              cover:
                'https://thu-pri-ups.yuketang.cn/common_uploads/test-slide',
            },
          ],
          avatar: {
            cover: 'https://thu-pri-ups.yuketang.cn/common_uploads/avatar',
          },
        },
      },
    ];
    for (const { endpoint, data } of responses) {
      const url = `https://pro.yuketang.cn/api/v3/classroom-report/student/${endpoint}?lesson_id=1785174499833394944`;
      contents.debugger.responseBody = JSON.stringify({ code: 0, data });
      contents.debugger.emit('message', {}, 'Network.requestWillBeSent', {
        requestId: endpoint,
        request: { method: 'GET', url },
      });
      contents.debugger.emit('message', {}, 'Network.responseReceived', {
        requestId: endpoint,
        type: 'XHR',
        response: {
          url,
          status: 200,
          mimeType: 'application/json',
          headers: {},
        },
      });
      contents.debugger.emit('message', {}, 'Network.loadingFinished', {
        requestId: endpoint,
        encodedDataLength: 100,
      });
      await vi.waitFor(() =>
        expect(received).toHaveBeenCalledWith(
          expect.objectContaining({
            lessonTitle: 'lec3-cnn-v3.6',
            presentation: expect.objectContaining({
              slides:
                endpoint === 'review'
                  ? [expect.objectContaining({ id: 'slide-1' })]
                  : [],
            }),
          }),
        ),
      );
    }
  });

  it('forwards successful browser answer responses without deep capture', async () => {
    const collector = new BrowserLessonCollector();
    const observations: unknown[] = [];
    collector.watchLesson('standard', 'lesson-1', 'presentation-1', (value) => {
      observations.push(value);
    });
    await collector.observeHttp({
      url: 'https://www.yuketang.cn/api/v3/lesson/presentation/fetch?presentation_id=presentation-1',
      statusCode: 200,
      body: JSON.stringify({
        data: {
          id: 'presentation-1',
          slides: [
            {
              id: 'slide-1',
              problem: {
                problemId: 'problem-1',
                problemType: 1,
                options: ['One', 'Two'],
              },
            },
          ],
        },
      }),
    });
    observations.length = 0;

    const contents = new FakeContents();
    const observer = new ElectronNetworkObserver(
      contents as never,
      new NetworkRecorder(),
      vi.fn(),
      collector,
      false,
    );
    await observer.start();
    contents.debugger.responseBody = JSON.stringify({ code: 0 });
    contents.debugger.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'answer-1',
      request: {
        method: 'POST',
        url: 'https://www.yuketang.cn/api/v3/lesson/problem/answer',
        postData: JSON.stringify({ problemId: 'problem-1', result: ['B'] }),
      },
    });
    contents.debugger.emit('message', {}, 'Network.responseReceived', {
      requestId: 'answer-1',
      type: 'XHR',
      response: {
        url: 'https://www.yuketang.cn/api/v3/lesson/problem/answer',
        status: 200,
        mimeType: 'application/json',
        headers: {},
      },
    });
    contents.debugger.emit('message', {}, 'Network.loadingFinished', {
      requestId: 'answer-1',
      encodedDataLength: 12,
    });

    await vi.waitFor(() => {
      expect(observations).toContainEqual({
        type: 'message',
        message: {
          op: 'problemanswered',
          problemId: 'problem-1',
          answer: ['B'],
        },
      });
    });
  });

  it('records API bodies above the safe preview limit with the development recorder', async () => {
    const contents = new FakeContents();
    const recorder = new DevelopmentNetworkRecorder();
    const observer = new ElectronNetworkObserver(
      contents as never,
      recorder,
      vi.fn(),
      undefined,
      false,
    );
    await observer.start();
    await observer.setDeepCapture(true);

    const body = JSON.stringify({ courses: ['x'.repeat(80 * 1024)] });
    contents.debugger.responseBody = body;
    contents.debugger.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'courses-1',
      request: {
        method: 'GET',
        url: 'https://pro.yuketang.cn/v2/api/web/courses/list?identity=2',
      },
    });
    contents.debugger.emit('message', {}, 'Network.responseReceived', {
      requestId: 'courses-1',
      type: 'XHR',
      response: {
        url: 'https://pro.yuketang.cn/v2/api/web/courses/list?identity=2',
        status: 200,
        mimeType: 'application/json',
        headers: {},
      },
    });
    contents.debugger.emit('message', {}, 'Network.loadingFinished', {
      requestId: 'courses-1',
      encodedDataLength: Buffer.byteLength(body),
    });

    await vi.waitFor(() => {
      expect(
        recorder.entries.find(
          (entry) => entry.kind === 'http' && entry.phase === 'body',
        ),
      ).toEqual(expect.objectContaining({ body }));
    });
  });
});

class FakeDebugger extends EventEmitter {
  responseBody = '';
  #attached = false;

  isAttached(): boolean {
    return this.#attached;
  }

  attach(): void {
    this.#attached = true;
  }

  detach(): void {
    this.#attached = false;
  }

  async sendCommand(method: string): Promise<unknown> {
    return method === 'Network.getResponseBody'
      ? { body: this.responseBody, base64Encoded: false }
      : {};
  }
}

class FakeContents {
  constructor(readonly id = 1) {}
  readonly debugger = new FakeDebugger();

  getURL(): string {
    return 'https://www.yuketang.cn/web';
  }

  isDestroyed(): boolean {
    return false;
  }
}
