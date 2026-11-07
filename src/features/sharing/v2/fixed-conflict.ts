import { addDays, daysBetween } from '../../../domain/scheduling/local-date.ts';
import { sharedLocalDate } from '../group-clock.ts';
import type { SharedOperation } from '../operations.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { DateTarget, ManualRuleFact, SharedChoreConfiguration } from './model.ts';
import type { V2HistoryView } from './history-view.ts';
import { V2HistoryConflictError } from './history-view.ts';
import { frameAtOperation } from './authority-context.ts';
import { commonFrames } from './common-frames.ts';
import { fixedAssignmentsOverlap, fixedInterval } from './date-target.ts';
import { materializeRuleTarget } from './rule-target.ts';
import { selectManualRule } from './period-rules.ts';
import { observedDateRules } from './formal-rule-view.ts';

/** A scoped local check against actual signed designations; no Calendar data or caller-supplied conflict flag. */
export function fixedConflictAtOperation(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], operation: SharedOperation,
  target: DateTarget, assigneeIds: string[], own: { occurrenceId: string; subjectUserId: string | null }, approved: readonly ManualRuleFact[] = []): boolean {
  const interval = fixedInterval(target); if (!interval || !assigneeIds.length) return false;
  const zone = view.field('settings', 'settings', 'timeZone', operation)?.value;
  if (typeof zone !== 'string') throw new Error('Missing shared timezone');
  const rules = observedDateRules(view, operation, approved);
  const visited = new Set<string>();
  const contexts = new Map<string, ReturnType<typeof frameAtOperation>>();
  for (const fact of rules.filter((item) => item.rule.mode === 'fixed')) {
    const rule = fact.rule; const previous = fixedInterval(rule.target); if (!previous) throw new Error('Invalid fixed designation');
    if (view.field('chore', rule.choreId, '$alive', operation)?.value !== true) continue;
    const config = view.field('chorePolicy', rule.choreId, 'configuration', operation,
      (op) => (op.payload.configuration as unknown as SharedChoreConfiguration).ruleVersion === rule.ruleVersion)?.value as unknown as SharedChoreConfiguration | undefined;
    if (!config) throw new Error('Missing designated rule version');
    let anchors: LocalDate[];
    if (rule.selector.scope === 'once') anchors = [rule.selector.anchorDate];
    else {
      const sourceZone = rule.timeZoneAtCreation;
      const startOffset = daysBetween(rule.referenceAnchorDate, sharedLocalDate(new Date(previous.start), sourceZone));
      const endOffset = daysBetween(rule.referenceAnchorDate, sharedLocalDate(new Date(previous.end), sourceZone));
      let from = addDays(sharedLocalDate(new Date(interval.start), sourceZone), -endOffset - 1);
      let through = addDays(sharedLocalDate(new Date(interval.end), sourceZone), -startOffset + 1);
      const selectorFrom = rule.selector.scope === 'period' ? rule.selector.range.from : rule.selector.from;
      const selectorThrough = rule.selector.scope === 'period' ? rule.selector.range.through : null;
      if (from < selectorFrom) from = selectorFrom; if (selectorThrough && through > selectorThrough) through = selectorThrough;
      anchors = from > through ? [] : commonFrames(view.groupId, rule.choreId, config, from, through).map((frame) => frame.anchorDate);
    }
    for (const anchor of anchors) {
      // Revisions of the same fixed rule share one authenticated read boundary.
      // Keep the rule version in this key: an invalid older version must still
      // fail its own authority check rather than hide behind a newer one.
      const identity = JSON.stringify([rule.choreId, anchor, rule.ruleVersion]);
      let context = contexts.get(identity);
      if (!context) {
        if (contexts.size >= 10_000) throw new V2HistoryConflictError('Fixed-date comparison needs a narrower review range');
        context = frameAtOperation(view, archive, operation, rule.choreId, anchor, rule.ruleVersion); contexts.set(identity, context);
      }
      const key = `${context.frame.id}:${rule.subjectUserId ?? ''}`;
      if (visited.has(key) || context.frame.id === own.occurrenceId && rule.subjectUserId === own.subjectUserId) continue;
      visited.add(key);
      const selected = selectManualRule(rules, context.frame, rule.subjectUserId, zone);
      if (selected.kind === 'conflict') throw new V2HistoryConflictError('Resolve concurrent fixed dates');
      if (selected.kind !== 'selected' || selected.fact.rule.mode !== 'fixed') continue;
      const other = materializeRuleTarget(selected.fact.rule, context.frame, zone);
      if (other.kind !== 'target') throw new V2HistoryConflictError('Confirm the changed recurrence before fixing another date');
      const others = rule.subjectUserId === null ? context.assigneeIds : context.subjectUserIds.includes(rule.subjectUserId) ? [rule.subjectUserId] : [];
      if (fixedAssignmentsOverlap({ target, assigneeIds }, { target: other.target, assigneeIds: others })) return true;
    }
  }
  return false;
}
