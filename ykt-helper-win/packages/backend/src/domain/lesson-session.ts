import type {
  AnswerValue,
  Lesson,
  Presentation,
  Problem,
  ProblemContext,
  Slide,
} from '@ykt/contracts';

export interface ProblemRuntimeState {
  problemId: string;
  presentationId: string;
  slideId: string;
  status: 'locked' | 'available' | 'answered' | 'expired';
  unlockedAt: number | null;
  deadlineAt: number | null;
}

export class LessonSession {
  readonly presentations = new Map<string, Presentation>();
  readonly slides = new Map<string, Slide>();
  readonly problems = new Map<string, Problem>();
  readonly problemStates = new Map<string, ProblemRuntimeState>();
  #lesson: Lesson;

  constructor(lesson: Lesson) {
    this.#lesson = { ...lesson };
  }

  get lesson(): Lesson {
    return { ...this.#lesson };
  }

  setLessonStatus(status: Lesson['status']): void {
    this.#lesson = { ...this.#lesson, status };
    if (status === 'ended') {
      for (const [id, state] of this.problemStates) {
        if (state.status === 'available') this.closeProblem(id);
      }
    }
  }

  updateLesson(lesson: Lesson): void {
    this.#lesson = { ...lesson, title: lesson.title || this.#lesson.title };
    this.setLessonStatus(lesson.status);
  }

  upsertPresentation(presentation: Presentation): void {
    this.presentations.set(presentation.id, presentation);
    for (const slide of presentation.slides) {
      this.slides.set(slide.id, slide);
      if (slide.problem) this.upsertProblem(slide.problem);
    }
  }

  upsertProblem(problem: Problem): void {
    const existing = this.problems.get(problem.id);
    // Once a review identified the published exercise, generic courseware
    // refreshes must not replace its image binding or submission route.
    if (existing?.source === 'classroom-report' && !problem.source) return;
    const merged =
      existing && existing.result !== null && problem.result === null
        ? { ...problem, result: existing.result }
        : problem;
    this.problems.set(problem.id, merged);
    const state = this.problemStates.get(problem.id);
    if (!state) {
      this.problemStates.set(problem.id, {
        problemId: problem.id,
        presentationId: problem.presentationId,
        slideId: problem.slideId,
        status: merged.result !== null ? 'answered' : 'locked',
        unlockedAt: null,
        deadlineAt: null,
      });
    } else {
      this.problemStates.set(problem.id, {
        ...state,
        presentationId: merged.presentationId,
        slideId: merged.slideId,
        status: merged.result !== null ? 'answered' : state.status,
      });
    }
  }

  unlockProblem(
    problemId: string,
    presentationId: string,
    slideId: string,
    unlockedAt: number,
    deadlineAt: number | null,
    now: number,
  ): void {
    const problem = this.problems.get(problemId);
    const previous = this.problemStates.get(problemId);
    this.problemStates.set(problemId, {
      problemId,
      presentationId,
      slideId,
      status:
        previous?.status === 'answered' ||
        (problem !== undefined && problem.result !== null)
          ? 'answered'
          : deadlineAt !== null && now >= deadlineAt
            ? 'expired'
            : 'available',
      unlockedAt,
      deadlineAt,
    });
  }

  closeProblem(problemId: string): void {
    const state = this.problemStates.get(problemId);
    if (state && state.status !== 'answered') {
      this.problemStates.set(problemId, { ...state, status: 'expired' });
    }
  }

  answerProblem(problemId: string, answer: AnswerValue): void {
    const problem = this.problems.get(problemId);
    if (!problem) return;
    this.problems.set(problemId, { ...problem, result: answer });

    const state = this.problemStates.get(problemId);
    if (state) {
      this.problemStates.set(problemId, { ...state, status: 'answered' });
    }
  }

  getProblemContext(
    problemId: string,
    now: number,
  ): ProblemContext | undefined {
    const problem = this.problems.get(problemId);
    if (!problem) return undefined;
    const storedState = this.problemStates.get(problemId);
    const status =
      problem.result !== null || storedState?.status === 'answered'
        ? 'answered'
        : storedState?.deadlineAt !== null &&
            storedState?.deadlineAt !== undefined &&
            now >= storedState.deadlineAt
          ? 'expired'
          : (storedState?.status ?? 'locked');

    return {
      ...problem,
      status,
      unlockedAt: storedState?.unlockedAt ?? null,
      deadlineAt: storedState?.deadlineAt ?? null,
    };
  }
}
