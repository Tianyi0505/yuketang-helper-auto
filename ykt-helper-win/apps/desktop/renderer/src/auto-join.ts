import type { Lesson } from '@ykt/contracts';

export async function enterActiveLessons(
  lessons: readonly Lesson[],
  connectedLessonIds: Set<string>,
  enterLesson: (lessonId: string) => Promise<void>,
): Promise<readonly string[]> {
  const enteredLessonIds: string[] = [];
  for (const lesson of lessons) {
    if (lesson.status !== 'active' || connectedLessonIds.has(lesson.id)) {
      continue;
    }
    try {
      await enterLesson(lesson.id);
    } catch {
      // A stale classroom or transient failure must not block the next class.
      // Failed entries are left unconnected and retried at the next poll.
      continue;
    }
    connectedLessonIds.add(lesson.id);
    enteredLessonIds.push(lesson.id);
  }
  return enteredLessonIds;
}
