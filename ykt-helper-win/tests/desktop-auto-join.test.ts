import type { Lesson } from '@ykt/contracts';
import { describe, expect, it, vi } from 'vitest';

import { enterActiveLessons } from '../apps/desktop/renderer/src/auto-join';

describe('automatic lesson entry', () => {
  it('continues into the next classroom when an earlier entry fails, and retries only the failed one', async () => {
    const lessons: Lesson[] = ['old', 'new'].map((id) => ({
      id,
      title: id,
      status: 'active',
    }));
    const connected = new Set<string>();
    const enter = vi.fn(async (id: string) => {
      if (id === 'old') throw new Error('ended');
    });
    expect(await enterActiveLessons(lessons, connected, enter)).toEqual([
      'new',
    ]);
    expect(connected).toEqual(new Set(['new']));
    enter.mockResolvedValue(undefined);
    expect(await enterActiveLessons(lessons, connected, enter)).toEqual([
      'old',
    ]);
    expect(enter.mock.calls.map(([id]) => id)).toEqual(['old', 'new', 'old']);
  });
  it('enters active lessons instead of only refreshing them', async () => {
    const lessons: readonly Lesson[] = [
      { id: 'active-1', title: 'Active lesson', status: 'active' },
      { id: 'upcoming-1', title: 'Upcoming lesson', status: 'upcoming' },
    ];
    const connectedLessonIds = new Set<string>();
    const enterLesson = vi.fn(async () => undefined);

    await expect(
      enterActiveLessons(lessons, connectedLessonIds, enterLesson),
    ).resolves.toEqual(['active-1']);
    expect(enterLesson).toHaveBeenCalledOnce();
    expect(enterLesson).toHaveBeenCalledWith('active-1');
    expect(connectedLessonIds).toEqual(new Set(['active-1']));
  });

  it('does not enter the same active lesson twice', async () => {
    const lesson: Lesson = {
      id: 'active-1',
      title: 'Active lesson',
      status: 'active',
    };
    const connectedLessonIds = new Set(['active-1']);
    const enterLesson = vi.fn(async () => undefined);

    await expect(
      enterActiveLessons([lesson], connectedLessonIds, enterLesson),
    ).resolves.toEqual([]);
    expect(enterLesson).not.toHaveBeenCalled();
  });
});
