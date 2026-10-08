export const automationStages = [
  'scheduled',
  'started',
  'generated',
  'submit-started',
  'submitted',
  'failed',
  'skipped',
] as const;

export interface AutomationLogInput {
  stage: (typeof automationStages)[number];
  lessonId: string;
  problemId: string;
  deadlineAt: number | null;
  remainingMs: number | null;
  delayMs: number | null;
  managedSubmit: boolean;
  reason: string;
}
