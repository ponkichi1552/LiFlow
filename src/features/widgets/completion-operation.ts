import type { ChoreScheduleEntry } from '../../domain/chores/types';
import type { LocalDate } from '../../domain/shared/types';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { isSharedTimeZone, sharedLocalDate } from '../sharing/group-clock.ts';
import { canonicalJson } from '../sharing/operations.ts';

/** Native acceptance is input, never an authorization grant or a completed business fact. */
export interface WidgetCompletionOperation {
  id: string; accountScope: string; householdCreatedAt: string; acceptedAtMs: number;
  completedLocalDate: LocalDate; timeZone: string; entry: ChoreScheduleEntry;
  completionGeneration?: number;
}
export function validateWidgetCompletionOperation(value: WidgetCompletionOperation): WidgetCompletionOperation {
  if (!value || typeof value !== 'object' || Object.keys(value).filter(key => key !== 'completionGeneration').sort().join(',') !== 'acceptedAtMs,accountScope,completedLocalDate,entry,householdCreatedAt,id,timeZone'
    || value.completionGeneration !== undefined && (!Number.isSafeInteger(value.completionGeneration) || value.completionGeneration < 0)
    || !/^completion-intent\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.id)
    || typeof value.accountScope !== 'string' || !value.accountScope.length || value.accountScope.length > 160
    || typeof value.householdCreatedAt !== 'string' || !Number.isFinite(Date.parse(value.householdCreatedAt)) || !Number.isSafeInteger(value.acceptedAtMs) || value.acceptedAtMs < 0
    || value.acceptedAtMs > 253402300799999 || !isSharedTimeZone(value.timeZone)) throw new Error('ウィジェットの保存待ち操作を確認できません。');
  parseLocalDate(value.completedLocalDate);
  if (sharedLocalDate(new Date(value.acceptedAtMs), value.timeZone) !== value.completedLocalDate) throw new Error('ウィジェットの実施日を確認できません。');
  const entry = value.entry;
  if (!entry || typeof entry !== 'object' || entry.householdId !== 'local-household'
    || typeof entry.choreId !== 'string' || !entry.choreId || entry.choreId.length > 1024
    || typeof entry.id !== 'string' || !entry.id || entry.id.length > 1024
    || !['initialPending', 'scheduled', 'inWindow', 'overdue'].includes(entry.status) || !Array.isArray(entry.assignedMemberIds)
    || entry.assignedMemberIds.some(id => typeof id !== 'string' || !id || id.length > 1024)) throw new Error('ウィジェットの対象予定を確認できません。');
  for (const date of [entry.cycleBaseDate, entry.suggestedDate, entry.windowStart, entry.windowEnd]) parseLocalDate(date);
  if (entry.windowStart > entry.windowEnd || entry.suggestedDate < entry.windowStart || entry.suggestedDate > entry.windowEnd
    || canonicalJson(value).length > 24_000) throw new Error('ウィジェットの対象期間を確認できません。');
  return JSON.parse(canonicalJson(value));
}
