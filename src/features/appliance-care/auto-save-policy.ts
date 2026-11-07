import type { ChoreDefinition } from '@/domain/chores/types';
import type { ApplianceCareAnalysisDraft } from './contracts';
import type { ApprovedApplianceCareTask } from './to-chore-definition';

export function defaultApplianceCycles(analysis: ApplianceCareAnalysisDraft, existing: readonly ChoreDefinition[] = []): Record<number, string> {
  return Object.fromEntries(analysis.tasks.map((task, index) => {
    const previous = existing.find((chore) => (chore.applianceTaskName ?? chore.name) === task.name);
    const days = previous?.userIntervalDays ?? previous?.recommendedCycleDays ?? task.recommendedIntervalDays;
    return [index, days === undefined ? '' : String(days)];
  }));
}

/** Verified manufacturer intervals are registered automatically; no interval is invented for condition-only tasks. */
export function automaticApplianceTasks(analysis: ApplianceCareAnalysisDraft, values: Record<number, string>): ApprovedApplianceCareTask[] {
  return analysis.tasks.map((task, index) => {
    const entered = values[index]?.normalize('NFKC').trim();
    const days = entered ? Number(entered) : undefined;
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new RangeError('周期は1〜3650日の整数で入力してください。');
    return { task, ...(days !== undefined ? { userIntervalDays: days }
      : task.recommendedIntervalDays !== undefined ? { userIntervalDays: task.recommendedIntervalDays } : { resetUserInterval: true }) };
  });
}
