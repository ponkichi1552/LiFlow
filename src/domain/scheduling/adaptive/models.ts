import type { LocalDate } from '../../shared/types';
import { addDays, daysBetween, parseLocalDate, weekdayOf } from '../local-date.ts';

export type AdaptiveMethod = 'median' | 'exponential' | 'weekly' | 'monthEnd' | 'alternating';
export type AdaptiveModel =
  | { method: 'median'; days: number }
  | { method: 'exponential'; days: number }
  | { method: 'weekly'; weeks: number; weekday: number; anchor: LocalDate }
  | { method: 'monthEnd'; months: number; anchor: LocalDate }
  | { method: 'alternating'; even: number; odd: number; nextOrdinal: number };
export interface AdaptiveInterval { days: number; ordinal: number }
const methods: readonly AdaptiveMethod[] = ['median', 'exponential', 'weekly', 'monthEnd', 'alternating'];
const positive = (value: number) => { if (!Number.isFinite(value) || value <= 0) throw new RangeError('周期の正の数値が必要です。'); return value; };
export const roundedAdaptiveDays = (value: number) => Math.max(1, Math.floor(positive(value)));
/** Pure catalogue defaults do not need weather or placement dependencies. */
export function adaptiveWindowRadius(period: number): number {
  const days = roundedAdaptiveDays(period);
  return days <= 7 ? 0 : days <= 13 ? 1 : days <= 29 ? 2 : days <= 59 ? 3 : days <= 89 ? 5 : days <= 179 ? 7 : 14;
}
/** A one-day phase of an alternating rule is not an everyday chore. */
export function adaptiveModelIsDaily(model: AdaptiveModel): boolean {
  return model.method === 'median' || model.method === 'exponential' ? roundedAdaptiveDays(model.days) === 1
    : model.method === 'alternating' && roundedAdaptiveDays(model.even) === 1 && roundedAdaptiveDays(model.odd) === 1;
}
export function adaptiveReferenceLimit(previousRepresentativeDays: number): 4 | 6 | 8 {
  const days = roundedAdaptiveDays(previousRepresentativeDays); return days <= 30 ? 8 : days <= 90 ? 6 : 4;
}
// Integer units are proportional to 1..1.5; half-weight ties never depend on floating-point accumulation.
function recencyUnits(length: number) {
  if (!Number.isSafeInteger(length) || length < 2) throw new RangeError('複数の間隔が必要です。');
  return Array.from({ length }, (_, i) => 2 * (length - 1) + i);
}
function median(values: readonly number[], units: readonly number[]): number {
  if (!values.length || values.length !== units.length) throw new RangeError('周期の観測値が必要です。');
  const sorted = values.map((value, i) => ({ value: positive(value), units: positive(units[i]), i })).sort((a, b) => a.value - b.value || a.i - b.i);
  const total = units.reduce((a, b) => a + b, 0); let accumulated = 0;
  for (let i = 0; i < sorted.length; i++) {
    accumulated += sorted[i].units;
    if (accumulated * 2 === total && i + 1 < sorted.length) return positive((sorted[i].value + sorted[i + 1].value) / 2);
    if (accumulated * 2 > total) return sorted[i].value;
  }
  throw new RangeError('周期の重みを集計できません。');
}
export function weightedIntervalMedian(values: readonly number[]) { return median(values, recencyUnits(values.length)); }
export function finiteExponentialMean(values: readonly number[]) {
  if (values.length < 2) throw new RangeError('複数の間隔が必要です。');
  const weights = values.map((_, i) => 1.5 ** (i / (values.length - 1)));
  return positive(values.reduce((sum, value, i) => sum + positive(value) * weights[i], 0) / weights.reduce((a, b) => a + b, 0));
}
function monthEndAt(index: number): LocalDate {
  if (!Number.isSafeInteger(index)) throw new RangeError('暦月を確認してください。');
  const year = Math.floor(index / 12); const month = index - year * 12;
  const day = new Date(Date.UTC(year, month + 1, 0)); const value = day.toISOString().slice(0, 10) as LocalDate;
  parseLocalDate(value); return value;
}
function monthIndex(day: LocalDate) { const date = parseLocalDate(day); return date.getUTCFullYear() * 12 + date.getUTCMonth(); }
export function nearestMonthEnd(day: LocalDate): LocalDate {
  const index = monthIndex(day); const previous = monthEndAt(index - 1); const current = monthEndAt(index);
  return daysBetween(previous, day) <= daysBetween(day, current) ? previous : current;
}
function dateIntervals(dates: readonly LocalDate[]) {
  for (const date of dates) parseLocalDate(date);
  return dates.slice(1).map((date, i) => positive(daysBetween(dates[i], date)));
}

/** Inputs are active, same-day aggregated and epoch-normalized by ordered replay; no UI render calls this. */
export function fitAdaptiveModels(input: { intervals: readonly AdaptiveInterval[]; currentEpochIntervals: readonly AdaptiveInterval[];
  currentEpochDates: readonly LocalDate[]; previousRepresentativeDays: number; retainingAlternating?: boolean }): AdaptiveModel[] {
  const limit = adaptiveReferenceLimit(input.previousRepresentativeDays);
  const validate = (values: readonly AdaptiveInterval[]) => {
    for (let i = 0; i < values.length; i++) {
      positive(values[i].days);
      if (!Number.isSafeInteger(values[i].ordinal) || values[i].ordinal < 0 || i > 0 && values[i - 1].ordinal >= values[i].ordinal) throw new RangeError('間隔の通し番号を確認してください。');
    }
  };
  validate(input.intervals); validate(input.currentEpochIntervals); dateIntervals(input.currentEpochDates);
  const selected = input.intervals.slice(-limit); const values = selected.map(row => row.days);
  if (values.length < 3) return [];
  const models: AdaptiveModel[] = [{ method: 'median', days: weightedIntervalMedian(values) }, { method: 'exponential', days: finiteExponentialMean(values) }];
  const dates = input.currentEpochDates.slice(-limit - 1);
  if (dates.length >= 4) {
    const gaps = dateIntervals(dates); const weeks = Math.max(1, Math.round(weightedIntervalMedian(gaps) / 7));
    const counts = new Map<number, number>(); const weights = recencyUnits(dates.length);
    for (const [i, day] of dates.entries()) counts.set(weekdayOf(day), (counts.get(weekdayOf(day)) ?? 0) + weights[i]);
    let weekday = weekdayOf(dates.at(-1)!); let best = -1;
    for (const day of dates) { const candidate = weekdayOf(day); const weight = counts.get(candidate)!; if (weight >= best) { best = weight; weekday = candidate; } }
    const latest = dates.at(-1)!; const before = (weekdayOf(latest) - weekday + 7) % 7; const after = (weekday - weekdayOf(latest) + 7) % 7;
    models.push({ method: 'weekly', weeks, weekday, anchor: addDays(latest, before <= after ? -before : after) });
    const ends = dates.map(nearestMonthEnd); const gapsInMonths = ends.slice(1).map((day, i) => monthIndex(day) - monthIndex(ends[i])).filter(gap => gap > 0);
    if (gapsInMonths.length >= 3) models.push({ method: 'monthEnd', months: Math.max(1, Math.round(weightedIntervalMedian(gapsInMonths))), anchor: ends.at(-1)! });
  }
  const alternating = input.currentEpochIntervals.slice(-limit); const units = alternating.length >= 4 ? recencyUnits(alternating.length) : [];
  const even = alternating.flatMap((row, i) => row.ordinal % 2 === 0 ? [{ ...row, units: units[i] }] : []);
  const odd = alternating.flatMap((row, i) => row.ordinal % 2 !== 0 ? [{ ...row, units: units[i] }] : []);
  if (alternating.length >= 4 && even.length >= 2 && odd.length >= 2) {
    const a = median(even.map(row => row.days), even.map(row => row.units)); const b = median(odd.map(row => row.days), odd.map(row => row.units));
    if (input.retainingAlternating || roundedAdaptiveDays(a) !== roundedAdaptiveDays(b)) models.push({ method: 'alternating', even: a, odd: b, nextOrdinal: alternating.at(-1)!.ordinal + 1 });
  }
  return models;
}
export function adaptiveRepresentativeDays(model: AdaptiveModel) {
  if (model.method === 'weekly') return roundedAdaptiveDays(7 * model.weeks);
  if (model.method === 'monthEnd') return roundedAdaptiveDays(30 * model.months);
  if (model.method === 'alternating') return roundedAdaptiveDays((model.even + model.odd) / 2);
  return roundedAdaptiveDays(model.days);
}
/** Preserve an adopted calendar phase; late completion closes missed rounds without fabricating completion events. */
export function predictAdaptiveDate(model: AdaptiveModel, completedDate: LocalDate, ruleDate?: LocalDate): LocalDate {
  parseLocalDate(completedDate);
  if (model.method === 'median' || model.method === 'exponential') return addDays(completedDate, roundedAdaptiveDays(model.days));
  if (model.method === 'alternating') return addDays(completedDate, roundedAdaptiveDays(model.nextOrdinal % 2 === 0 ? model.even : model.odd));
  const anchor = ruleDate ?? model.anchor; parseLocalDate(anchor);
  if (model.method === 'weekly') {
    if (!Number.isSafeInteger(model.weeks) || model.weeks < 1 || weekdayOf(anchor) !== model.weekday) throw new RangeError('曜日の位相を確認してください。');
    const interval = 7 * model.weeks; const count = Math.max(1, Math.floor(daysBetween(anchor, completedDate) / interval) + 1);
    return addDays(anchor, interval * count);
  }
  if (!Number.isSafeInteger(model.months) || model.months < 1 || nearestMonthEnd(anchor) !== anchor) throw new RangeError('月末の位相を確認してください。');
  let count = Math.max(1, Math.floor((monthIndex(completedDate) - monthIndex(anchor)) / model.months));
  let next = monthEndAt(monthIndex(anchor) + count * model.months);
  if (next <= completedDate) next = monthEndAt(monthIndex(anchor) + ++count * model.months);
  return next;
}
/** The next window uses one real rule interval, even when completion skipped older calendar rounds. */
export function adaptiveNextIntervalDays(model: AdaptiveModel, completedDate: LocalDate, ruleDate?: LocalDate): number {
  if (model.method === 'alternating') return roundedAdaptiveDays(model.nextOrdinal % 2 === 0 ? model.even : model.odd);
  if (model.method !== 'monthEnd') return adaptiveRepresentativeDays(model);
  const next = predictAdaptiveDate(model, completedDate, ruleDate);
  return daysBetween(monthEndAt(monthIndex(next) - model.months), next);
}
export interface AdaptiveForecastScore { epoch: string; completionId: string; errors: Partial<Record<AdaptiveMethod, number>> }
/** Only genuinely pre-recorded, same-epoch forecasts may be provided by the journal. */
export function chooseAdaptiveMethod(current: AdaptiveMethod, scores: readonly AdaptiveForecastScore[], epoch: string,
  available: readonly AdaptiveMethod[]): AdaptiveMethod {
  const candidates: { method: AdaptiveMethod; mean: number; maximum: number }[] = [];
  for (const method of methods) {
    if (method === current || !available.includes(method)) continue;
    const common: AdaptiveForecastScore[] = [];
    for (let index = scores.length - 1; index >= 0 && common.length < 3; index--) {
      const row = scores[index];
      if (row.epoch === epoch && row.errors[current] !== undefined && row.errors[method] !== undefined) common.push(row);
    }
    common.reverse();
    if (common.length !== 3 || new Set(common.map(row => row.completionId)).size !== 3) continue;
    const observed = common.map(row => [row.errors[current]!, row.errors[method]!] as const);
    if (observed.some(pair => pair.some(error => !Number.isFinite(error) || error < 0))) throw new RangeError('予測誤差を確認してください。');
    const weightedSum = (index: number) => observed.reduce((sum, pair, i) => sum + pair[index] * (1 + 0.25 * i), 0);
    const before = weightedSum(0); const after = weightedSum(1); const improvement = before - after; const mean = after / 3.75;
    if (before > 0 && observed.filter(pair => pair[1] < pair[0]).length >= 2 && improvement * 5 >= before && improvement >= 0.5 * 3.75)
      candidates.push({ method, mean, maximum: Math.max(...observed.map(pair => pair[1])) });
  }
  return candidates.sort((a, b) => a.mean - b.mean || a.maximum - b.maximum || methods.indexOf(a.method) - methods.indexOf(b.method))[0]?.method ?? current;
}
