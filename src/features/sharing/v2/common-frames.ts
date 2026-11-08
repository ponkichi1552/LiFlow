import { addDays, daysBetween, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { v2OccurrenceId } from './occurrence-id.ts';
import type { SharedChoreConfiguration, SharedOccurrence } from './model.ts';
import { v2AnchorAtIndex, v2AnchorIndexBefore, v2AnchorIndexOnOrAfter } from './cadence.ts';

/** Common anchors depend only on the signed configuration, never on an individual's recommendation or completion. */
export function commonFrame(groupId: string, choreId: string, configuration: SharedChoreConfiguration, anchorDate: LocalDate): SharedOccurrence {
  parseLocalDate(configuration.anchorDate); parseLocalDate(anchorDate);
  if (!Number.isSafeInteger(configuration.intervalDays) || configuration.intervalDays < 1 || configuration.intervalDays > 3650
    || configuration.monthly !== undefined && typeof configuration.monthly !== 'boolean'
    || !Number.isSafeInteger(configuration.ruleVersion) || configuration.ruleVersion < 1
    || [configuration.windowBeforeDays, configuration.windowAfterDays].some((days) => !Number.isSafeInteger(days) || days < 0 || days > 14)) throw new Error('Invalid common recurrence');
  const index = v2AnchorIndexBefore(configuration, anchorDate);
  if (index < 0 || v2AnchorAtIndex(configuration, index) !== anchorDate) throw new Error('Anchor is not a common occurrence');
  return { id: v2OccurrenceId(groupId, choreId, anchorDate), choreId, anchorDate,
    windowStart: addDays(anchorDate, -configuration.windowBeforeDays), windowEnd: addDays(anchorDate, configuration.windowAfterDays), ruleVersion: configuration.ruleVersion };
}
export function commonFrames(groupId: string, choreId: string, configuration: SharedChoreConfiguration,
  from: LocalDate, through: LocalDate): SharedOccurrence[] {
  parseLocalDate(from); parseLocalDate(through);
  if (through < from || daysBetween(from, through) > 3650) throw new Error('Invalid common planning horizon');
  const owned = { ...configuration };
  commonFrame(groupId, choreId, owned, owned.anchorDate);
  const first = v2AnchorIndexOnOrAfter(owned, from);
  const last = v2AnchorIndexBefore(owned, through);
  const result: SharedOccurrence[] = [];
  for (let index = first; index <= last; index++) {
    const anchor = v2AnchorAtIndex(owned, index);
    result.push({ id: v2OccurrenceId(groupId, choreId, anchor), choreId, anchorDate: anchor,
      windowStart: addDays(anchor, -owned.windowBeforeDays), windowEnd: addDays(anchor, owned.windowAfterDays), ruleVersion: owned.ruleVersion });
  }
  return result;
}
