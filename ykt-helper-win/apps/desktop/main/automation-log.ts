import { automationStages, type AutomationLogInput } from '@ykt/contracts';
import type { AppDataStore } from '@ykt/storage';

/** Restricted renderer diagnostics; no arbitrary log scope or payload is accepted. */
export async function recordAutomationLog(
  store: AppDataStore,
  input: unknown,
): Promise<void> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid automation diagnostic.');
  const value = input as Record<string, unknown>;
  const allowed = [
    'stage',
    'lessonId',
    'problemId',
    'deadlineAt',
    'remainingMs',
    'delayMs',
    'managedSubmit',
    'reason',
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !automationStages.includes(value.stage as AutomationLogInput['stage']) ||
    !['lessonId', 'problemId'].every(
      (key) =>
        typeof value[key] === 'string' &&
        value[key].length > 0 &&
        value[key].length <= 200,
    ) ||
    !['deadlineAt', 'remainingMs', 'delayMs'].every(
      (key) =>
        value[key] === null ||
        (typeof value[key] === 'number' && Number.isFinite(value[key])),
    ) ||
    typeof value.managedSubmit !== 'boolean' ||
    typeof value.reason !== 'string' ||
    value.reason.length > 2048
  ) {
    throw new Error('Invalid automation diagnostic.');
  }
  const event = input as AutomationLogInput;
  const messages: Record<AutomationLogInput['stage'], string> = {
    scheduled: '自动答题已排队。',
    started: '自动答题开始分析。',
    generated: '自动答题已生成建议。',
    'submit-started': '自动答题开始提交。',
    submitted: '自动答题已提交。',
    failed: '自动答题失败，本轮不会重新排队。',
    skipped: '自动答题已跳过。',
  };
  await store.appendLog({
    level:
      event.stage === 'failed'
        ? 'error'
        : event.stage === 'skipped'
          ? 'warn'
          : 'info',
    scope: 'automation',
    message: messages[event.stage],
    details: { ...event, confirmedBy: 'agent' },
  });
}
