import { addDays, daysBetween } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types';
import type { V2CommonPlan, V2PlannedOccurrence } from './common-plan';
import type { V2ConfigurationSlice } from './configuration-timeline';
import type { ManualRuleFact } from './model';
import { v2RuleCalendarAnchorRange } from './rule-target.ts';

/** Read-only sparse queries: one upcoming round per long chore, never a many-year daily plan. */
export function nextLongCalendarRounds(input: {
  plan: V2CommonPlan; viewerUserId: string; timeline(choreId: string): readonly V2ConfigurationSlice[];
  dateRules?: readonly ManualRuleFact[];
  readAt(anchor: LocalDate): V2CommonPlan;
}): V2PlannedOccurrence[] {
  const today = input.plan.range.asOfDate; const result: V2PlannedOccurrence[] = [];
  const key = (choreId: string, anchor: LocalDate, version: number) => JSON.stringify([choreId, anchor, version]);
  const indexPlan = (plan: V2CommonPlan) => {
    const index = new Map<string, V2PlannedOccurrence>();
    for (const round of plan.occurrences) {
      const id = key(round.choreId, round.anchorDate, round.ruleVersion);
      if (!index.has(id)) index.set(id, round);
    }
    return index;
  };
  const current = indexPlan(input.plan);
  const cache = new Map<LocalDate, ReturnType<typeof indexPlan>>();
  for (const chore of input.plan.chores) {
    if (!chore.enabled || chore.archived) continue;
    const choices: { round: V2PlannedOccurrence; date: LocalDate }[] = [];
    for (const slice of input.timeline(chore.id)) {
      const cfg = slice.configuration;
      if (!cfg || cfg.active === false || cfg.monthly || cfg.intervalDays < 90) continue;
      const searches: { near: LocalDate; from: LocalDate; through: LocalDate | null }[] = [{ near: today, from: slice.from, through: slice.through }];
      for (const { rule } of input.dateRules ?? []) if (rule.choreId === chore.id && rule.ruleVersion === cfg.ruleVersion) {
        if (rule.selector.scope === 'once') searches.push({ near: rule.selector.anchorDate, from: rule.selector.anchorDate, through: rule.selector.anchorDate });
        else try {
          const inverse = v2RuleCalendarAnchorRange(rule, today, today, input.plan.timeZone);
          const first = rule.selector.scope === 'period' ? rule.selector.range.from : rule.selector.from;
          const last = rule.selector.scope === 'period' ? rule.selector.range.through : null;
          searches.push({ near: inverse.from, from: first > slice.from ? first : slice.from,
            through: last && (!slice.through || last < slice.through) ? last : slice.through });
        } catch { /* The common plan retains the invalid-time/date-rule review. */ }
      }
      for (const search of searches) {
        let index = Math.max(0, Math.floor(daysBetween(cfg.anchorDate, search.near) / cfg.intervalDays), Math.ceil(daysBetween(cfg.anchorDate, search.from) / cfg.intervalDays));
        // Missing a deadline never creates a completion. Query the next genuine
        // frame with the full authority, dependency and date-rule inputs intact.
        for (let attempt = 0; attempt < 32; attempt++, index++) {
          let anchor: LocalDate; try { anchor = addDays(cfg.anchorDate, index * cfg.intervalDays); } catch { break; }
          if (search.through && anchor > search.through || slice.through && anchor > slice.through || anchor < slice.from) break;
          const identity = key(chore.id, anchor, cfg.ruleVersion);
          let round = current.get(identity);
          if (!round) {
            let plan = cache.get(anchor); if (!plan) { plan = indexPlan(input.readAt(anchor)); cache.set(anchor, plan); }
            round = plan.get(identity);
          }
          if (!round || !round.activeInPeriod) continue;
          const available = round.subjects.filter(subject => (subject.subjectUserId === null || subject.subjectUserId === input.viewerUserId)
            && subject.required && !subject.completed && subject.executionWindowEnd >= today);
          if (!available.length) continue;
          choices.push({ round, date: available.map(subject => subject.suggestedDate).sort()[0] }); break;
        }
      }
    }
    choices.sort((a, b) => a.date.localeCompare(b.date) || a.round.id.localeCompare(b.round.id));
    if (choices[0]) result.push(choices[0].round);
  }
  return result;
}
