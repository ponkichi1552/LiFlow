import type { ChoreDefinition, ChoreScheduleEntry } from '../../domain/chores/types';
import type { LocalDate } from '../../domain/shared/types';
import type { PlannerSnapshot } from '../../platform/storage/repository';
import { addDays, daysBetween, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { registeredChoreCycleDays } from '../../domain/chores/cycle-policy.ts';
import { completionMatchesEntry } from '../../domain/scheduling/completion-matching.ts';
import { predictAdaptiveDate, roundedAdaptiveDays } from '../../domain/scheduling/adaptive/models.ts';
import type { AdaptiveModel } from '../../domain/scheduling/adaptive/models';

export const LONG_CALENDAR_CYCLE_DAYS = 90;
export interface LongCalendarPreview { chore: ChoreDefinition; entry: ChoreScheduleEntry; provisional: boolean }

/** One next round per long chore. This never advances history, writes a plan or allocates a time slot. */
export function personalLongCalendarPreviews(snapshot: PlannerSnapshot, today: LocalDate): LongCalendarPreview[] {
  const result: LongCalendarPreview[] = [];
  const entriesByChore = new Map<string, ChoreScheduleEntry[]>();
  const completionsByChore = new Map<string, typeof snapshot.completions>();
  for (const entry of snapshot.scheduleEntries) {
    const rows = entriesByChore.get(entry.choreId) ?? []; rows.push(entry); entriesByChore.set(entry.choreId, rows);
  }
  for (const completion of snapshot.completions) if (completion.outcome === 'completed') {
    const rows = completionsByChore.get(completion.choreId) ?? []; rows.push(completion); completionsByChore.set(completion.choreId, rows);
  }
  for (const chore of snapshot.chores) {
    if (!chore.enabled || chore.archived || chore.personalSchedulingKind === 'seasonal') continue;
    const cadence = snapshot.personalCadences?.[chore.id];
    const days = cadence ? cadence.days : registeredChoreCycleDays(chore, snapshot.settings.frequencyMode);
    const calendarMonths = cadence?.calendarModel?.method === 'monthEnd' ? cadence.calendarModel.months : 0;
    if (days === undefined || days === null || days < LONG_CALENDAR_CYCLE_DAYS && calendarMonths < 3) continue;
    const completed = completionsByChore.get(chore.id) ?? [];
    const entries = (entriesByChore.get(chore.id) ?? []).filter(row => !completed.some(completion => completionMatchesEntry(completion, row)))
      .sort((a, b) => a.cycleBaseDate.localeCompare(b.cycleBaseDate) || a.id.localeCompare(b.id));
    const actual = entries.find(entry => entry.windowEnd >= today);
    if (actual) { result.push({ chore, entry: actual, provisional: false }); continue; }
    const expired = entries.at(-1); if (!expired) continue;
    let model: AdaptiveModel | undefined = cadence?.calendarModel;
    if (!model && cadence?.automatic) continue; // An old cached learned model is not a guessed fixed interval.
    model ??= { method: 'median', days };
    const radius = cadence?.windowRadiusDays ?? chore.userWindowRadiusDays ?? chore.windowRadiusDays;
    let base = expired.cycleBaseDate;
    // Seek in the adopted cadence; missed rounds do not need individual materialization.
    try {
      const threshold = addDays(today, -radius); const gap = daysBetween(base, threshold);
      if (model.method === 'median' || model.method === 'exponential') {
        const interval = roundedAdaptiveDays(model.days);
        base = addDays(base, Math.max(0, Math.ceil(gap / interval) - 1) * interval);
      } else if (model.method === 'alternating') {
        const pairDays = roundedAdaptiveDays(model.even) + roundedAdaptiveDays(model.odd);
        const pairs = Math.max(0, Math.floor((gap - 1) / pairDays));
        base = addDays(base, pairs * pairDays); model = { ...model, nextOrdinal: model.nextOrdinal + pairs * 2 };
      } else if (threshold > base) base = addDays(threshold, -1);
    } catch { continue; }
    for (let count = 0; count < 3; count++) {
      if (model.method === 'alternating') model = { ...model, nextOrdinal: model.nextOrdinal + 1 };
      let start: LocalDate; let end: LocalDate;
      try {
        const next = predictAdaptiveDate(model, base); if (next <= base) break; base = next;
        start = addDays(base, -radius); end = addDays(base, radius); parseLocalDate(start); parseLocalDate(end);
      } catch { break; } // A date beyond the supported calendar cannot break other saved appointments.
      if (end < today) continue;
      result.push({ chore, provisional: true, entry: { ...expired, id: `calendar-preview:${expired.id}:${base}`, cycleBaseDate: base,
        suggestedDate: base, windowStart: start, windowEnd: end, status: 'scheduled', overdueDays: undefined, overdueCycles: undefined } });
      break;
    }
  }
  return result;
}
