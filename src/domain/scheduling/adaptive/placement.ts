import type { ChoreLoad } from '../../chores/types';
import type { LocalDate } from '../../shared/types';
import { addDays, daysBetween, parseLocalDate } from '../local-date.ts';
import { roundedAdaptiveDays } from './models.ts';
import { createMetWeatherEvaluator } from '../../../../server/appliance-care-api/src/weather/forecast.mjs';
import type { MetForecast } from '../../../../server/appliance-care-api/src/weather/forecast.mjs';

export interface InstantSpan { start: number; end: number }
export interface AdaptivePlacementDay {
  date: LocalDate; bounds: InstantSpan; allowed: readonly InstantSpan[]; holiday: boolean;
  maximumMinutes?: number; heavyLimit: number; normalLimit: number;
}
export interface AdaptiveRoundPlacement {
  id: string; originalBaseDate: LocalDate; placedBaseDate: LocalDate; recommendedDate: LocalDate;
  basicWindow: { from: LocalDate; through: LocalDate } | null;
  displayedWindow: { from: LocalDate; through: LocalDate } | null;
  slot: InstantSpan | null; fallback: boolean;
}
export interface AdaptivePlacementTask {
  id: string; choreId: string; baseDate: LocalDate; periodDays: number; minutes: number | null; load: ChoreLoad;
  purpose: 'initial' | 'nextRound' | 'automatic' | 'direct'; previous?: AdaptiveRoundPlacement;
  lastCompletedDate?: LocalDate; fixedDaily: boolean; windowRadiusDays?: number;
  holidayPriority?: boolean;
  weatherSensitive?: boolean;
}
export interface AdaptivePlacementLoad {
  roundId: string; date: LocalDate; minutes: number | null; load: ChoreLoad; slot: InstantSpan | null;
}
interface DayLoad { minutes: number; heavy: number; normal: number; count: number }
interface WindowCandidate { base: LocalDate; from: LocalDate; through: LocalDate }
const minute = 60_000;
const validSpan = (span: InstantSpan) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start;
function nonnegative(value: number) { return Number.isFinite(value) && value >= 0; }
export function unionInstantSpans(input: readonly InstantSpan[]): InstantSpan[] {
  const sorted = input.map(span => {
    const copy = { ...span }; if (!validSpan(copy)) throw new Error('予定の時間範囲を確認してください。'); return copy;
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const result: InstantSpan[] = [];
  for (const span of sorted) {
    const last = result.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else result.push(span);
  }
  return result;
}
/** Busy input is normalized once. Binary search avoids rescanning a whole calendar for each day. */
export function subtractInstantSpans(allowed: readonly InstantSpan[], unionBusy: readonly InstantSpan[]): InstantSpan[] {
  return unionInstantSpans(allowed).flatMap(span => {
    let low = 0; let high = unionBusy.length;
    while (low < high) { const mid = (low + high) >>> 1; if (unionBusy[mid].end <= span.start) low = mid + 1; else high = mid; }
    const free: InstantSpan[] = []; let start = span.start;
    for (let i = low; i < unionBusy.length && unionBusy[i].start < span.end; i++) {
      const busy = unionBusy[i]; if (busy.start > start) free.push({ start, end: Math.min(busy.start, span.end) });
      start = Math.max(start, busy.end); if (start >= span.end) break;
    }
    if (start < span.end) free.push({ start, end: span.end }); return free;
  });
}
function reserveInstantSpan(union: InstantSpan[], span: InstantSpan) {
  let low = 0; let high = union.length;
  while (low < high) { const mid = (low + high) >>> 1; if (union[mid].end < span.start) low = mid + 1; else high = mid; }
  let end = low; const merged = { ...span };
  while (end < union.length && union[end].start <= merged.end) { merged.start = Math.min(merged.start, union[end].start); merged.end = Math.max(merged.end, union[end].end); end++; }
  union.splice(low, end - low, merged);
}
export function adaptiveWindowRadius(period: number): number {
  const days = roundedAdaptiveDays(period);
  return days <= 7 ? 0 : days <= 13 ? 1 : days <= 29 ? 2 : days <= 59 ? 3 : days <= 89 ? 5 : days <= 179 ? 7 : 14;
}
/** Saved once with the first real round; this seed is never a fabricated completion. */
export function initialAdaptiveBaseDate(input: { today: LocalDate; periodDays: number; ownerId: string; choreId: string;
  version: string; fingerprint(value: unknown): string }): LocalDate {
  parseLocalDate(input.today);
  if (!input.ownerId || !input.choreId || !input.version) throw new Error('初回予定の識別情報を確認してください。');
  const digest = input.fingerprint(['adaptive-initial-v1', input.ownerId, input.choreId, input.version]);
  if (!/^[a-f0-9]{8,}$/iu.test(digest)) throw new Error('初回予定の計算版を確認してください。');
  return addDays(input.today, parseInt(digest.slice(0, 8), 16) % Math.min(roundedAdaptiveDays(input.periodDays), 30));
}
/** Every interval is tested at most once, in the specification's near-before/near-after order. */
export function adaptivePlacementWindows(baseDate: LocalDate, radius: number): WindowCandidate[] {
  return [...placementWindowCandidates(baseDate, radius)];
}
function* placementWindowCandidates(baseDate: LocalDate, radius: number): Generator<WindowCandidate> {
  parseLocalDate(baseDate);
  if (!Number.isSafeInteger(radius) || radius < 0 || radius > 14) throw new Error('家事の実施期間を確認してください。');
  const width = radius * 2 + 1; const extra = radius ? Math.floor(width * 1.5) - width : 0;
  const movement = Math.floor(width * 1.2); const centers = [0];
  for (let step = 1; step <= movement; step++) centers.push(-step, step);
  const seen = new Set<string>();
  for (const movement of centers) {
    const base = addDays(baseDate, movement);
    for (let amount = 0; amount <= extra; amount++) {
      const sides = new Set<number>();
      for (let offset = 0; sides.size < amount + 1; offset++) {
        for (const before of [Math.ceil(amount / 2) + offset, Math.floor(amount / 2) - offset]) if (before >= 0 && before <= amount) sides.add(before);
      }
      for (const before of sides) {
        const from = addDays(base, -radius - before); const through = addDays(base, radius + amount - before);
        const key = `${from}/${through}`; if (seen.has(key)) continue;
        seen.add(key); yield { base, from, through };
      }
    }
  }
}

/** Pure finite placement. Caller commits the whole result only against its captured input version. */
export function placeAdaptiveRounds(input: {
  tasks: readonly AdaptivePlacementTask[]; days: readonly AdaptivePlacementDay[]; busy: readonly InstantSpan[];
  fixedLoads: readonly AdaptivePlacementLoad[]; today: LocalDate; now: number; holidaysConfigured: boolean; weatherForecast?: MetForecast;
}): AdaptiveRoundPlacement[] {
  parseLocalDate(input.today); if (!Number.isFinite(input.now)) throw new Error('予定計算の現在時刻を確認してください。');
  const tomorrow = addDays(input.today, 1); const dayByDate = new Map<LocalDate, AdaptivePlacementDay>();
  const dayLoads = new Map<LocalDate, DayLoad>(); const allLoads = new Map<string, AdaptivePlacementLoad>();
  const reserved = unionInstantSpans(input.busy); const result = new Map<string, AdaptiveRoundPlacement>();
  const weather = createMetWeatherEvaluator(input.weatherForecast);
  for (const day of input.days) {
    parseLocalDate(day.date);
    if (dayByDate.has(day.date) || !validSpan(day.bounds) || day.maximumMinutes !== undefined && !nonnegative(day.maximumMinutes)
      || !Number.isSafeInteger(day.heavyLimit) || day.heavyLimit < 0 || !Number.isSafeInteger(day.normalLimit) || day.normalLimit < 0) throw new Error('日別の家事設定を確認してください。');
    unionInstantSpans(day.allowed); dayByDate.set(day.date, day);
  }
  const configuredDays = [...dayByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < configuredDays.length; i++) if (configuredDays[i].bounds.start < configuredDays[i - 1].bounds.end) throw new Error('日付の時間範囲が重複しています。');
  const allAllowed = unionInstantSpans(configuredDays.flatMap(day => day.allowed));
  const capacityByDate = new Map(configuredDays.map(day => [day.date, day.maximumMinutes ?? allAllowed
    .reduce((sum, span) => sum + Math.max(0, Math.min(span.end, day.bounds.end) - Math.max(span.start, day.bounds.start)) / minute, 0)]));
  const capacity = (day: AdaptivePlacementDay) => capacityByDate.get(day.date)!;
  const readLoad = (date: LocalDate) => dayLoads.get(date) ?? { minutes: 0, heavy: 0, normal: 0, count: 0 };
  function charges(load: AdaptivePlacementLoad): { day: AdaptivePlacementDay; minutes: number }[] {
    if (!load.slot) {
      const day = dayByDate.get(load.date);
      // Unknown manufacturer times stay unknown. Reserve the day's configured
      // capacity conservatively; never claim a made-up continuous free slot.
      return day ? [{ day, minutes: load.minutes ?? capacity(day) }] : [];
    }
    let low = 0; let high = configuredDays.length;
    while (low < high) { const mid = (low + high) >>> 1; if (configuredDays[mid].bounds.end <= load.slot!.start) low = mid + 1; else high = mid; }
    const portions: { day: AdaptivePlacementDay; minutes: number }[] = [];
    for (let i = low; i < configuredDays.length && configuredDays[i].bounds.start < load.slot.end; i++) {
      const day = configuredDays[i];
      const overlap = Math.max(0, Math.min(day.bounds.end, load.slot!.end) - Math.max(day.bounds.start, load.slot!.start));
      if (overlap) portions.push({ day, minutes: overlap / minute });
    }
    return portions;
  }
  function reserve(load: AdaptivePlacementLoad) {
    const previous = allLoads.get(load.roundId);
    if (previous) {
      if (previous.date !== load.date || previous.minutes !== load.minutes || previous.load !== load.load
        || previous.slot?.start !== load.slot?.start || previous.slot?.end !== load.slot?.end) throw new Error('同じ家事回の負荷が重複しています。'); return;
    }
    allLoads.set(load.roundId, load);
    for (const portion of charges(load)) {
      const total = { ...readLoad(portion.day.date) }; total.minutes += portion.minutes; dayLoads.set(portion.day.date, total);
    }
    const total = { ...readLoad(load.date) };
    if (!load.slot && !dayByDate.has(load.date)) total.minutes += load.minutes ?? 0;
    total.heavy += Number(load.load === 'heavy'); total.normal += Number(load.load === 'normal'); total.count++;
    dayLoads.set(load.date, total);
    if (load.slot) reserveInstantSpan(reserved, load.slot);
  }
  const taskIds = new Set(input.tasks.map(task => task.id));
  if (taskIds.size !== input.tasks.length || new Set(input.tasks.map(task => task.choreId)).size !== input.tasks.length) throw new Error('同じ家事の未完了回が重複しています。');
  for (const load of input.fixedLoads) {
    if (taskIds.has(load.roundId)) throw new Error('再配置対象の古い負荷を先に外してください。');
    if (!load.roundId || load.minutes !== null && (!Number.isFinite(load.minutes) || load.minutes <= 0)
      || load.slot && (!validSpan(load.slot) || load.minutes === null)) throw new Error('既存家事の負荷を確認してください。');
    reserve(load);
  }
  function radiusFor(task: AdaptivePlacementTask) {
    const radius = task.fixedDaily ? 0 : task.windowRadiusDays ?? adaptiveWindowRadius(task.periodDays);
    if (!Number.isSafeInteger(radius) || radius < 0 || radius > 14) throw new Error('実施期間を確認してください。'); return radius;
  }
  const tasks = input.tasks.map(task => {
    parseLocalDate(task.baseDate); if (task.lastCompletedDate) parseLocalDate(task.lastCompletedDate);
    if (task.previous && (task.previous.id !== task.id || task.previous.slot && !validSpan(task.previous.slot))) throw new Error('前回の予定回を確認してください。');
    const period = roundedAdaptiveDays(task.periodDays);
    if (task.fixedDaily && period !== 1) throw new Error('毎日固定の周期を確認してください。');
    if (!task.id || !task.choreId || task.minutes !== null && (!Number.isFinite(task.minutes) || task.minutes <= 0) || !['heavy', 'normal', 'light'].includes(task.load)
      || task.holidayPriority !== undefined && typeof task.holidayPriority !== 'boolean') throw new Error('家事の作業時間・負荷を確認してください。');
    const radius = radiusFor(task);
    const protectedRound = task.previous && task.purpose === 'automatic' && (task.fixedDaily || task.previous.recommendedDate <= tomorrow);
    const firstInitialEnd = addDays(input.today, Math.min(period, 30) - 1);
    const lastConfiguredDate = configuredDays.at(-1)?.date;
    const initialWindows = task.purpose === 'initial' ? [{ base: task.baseDate, from: input.today, through: firstInitialEnd },
      // Search only dates actually supplied by the caller. A long cycle is not
      // converted into a giant allocation or an invented free calendar.
      ...(period > 30 && lastConfiguredDate && lastConfiguredDate > firstInitialEnd ? [{ base: task.baseDate, from: input.today,
        through: daysBetween(input.today, lastConfiguredDate) < period ? lastConfiguredDate : addDays(input.today, period - 1) }] : [])] : null;
    if (initialWindows && (task.baseDate < input.today || task.baseDate > firstInitialEnd)) throw new Error('初回基準日は最初の探索範囲に保存してください。');
    const windows = protectedRound ? [] : initialWindows ?? adaptivePlacementWindows(task.baseDate, radius).filter(window => {
      if (task.fixedDaily && window.base !== task.baseDate) return false;
      return task.load !== 'heavy' || task.holidayPriority === false || !radius || !input.holidaysConfigured
        || configuredDays.some(day => day.holiday && day.date >= window.from && day.date <= window.through);
    });
    return { ...task, radius, windows };
  });
  const retained = tasks.filter(task => task.previous && task.purpose === 'automatic'
    && (task.fixedDaily || task.previous.recommendedDate <= tomorrow));
  for (const task of retained) {
    const previous = task.minutes === null ? { ...task.previous!, slot: null } : task.previous!; result.set(task.id, { ...previous });
    reserve({ roundId: task.id, date: previous.recommendedDate, slot: previous.slot, load: task.load, minutes: task.minutes });
  }
  function admissibleDate(task: AdaptivePlacementTask, date: LocalDate) {
    return date >= input.today && (!task.lastCompletedDate || date > task.lastCompletedDate)
      && (task.purpose !== 'automatic' || date > tomorrow) && (task.purpose !== 'direct' || date === task.baseDate)
      && (!task.fixedDaily || date === task.baseDate);
  }
  function optionsFor(task: typeof tasks[number]) {
    if (!task.windows.length || task.minutes === null) return [];
    const minutes = task.minutes;
    const earliest = task.windows.reduce((date, window) => date < window.from ? date : window.from, task.baseDate);
    const latest = task.windows.reduce((date, window) => date > window.through ? date : window.through, task.baseDate);
    return configuredDays.flatMap(day => {
      if (day.date < earliest || day.date > latest || !admissibleDate(task, day.date) || capacity(day) <= 0) return [];
      let initialDisplay: WindowCandidate | undefined;
      if (task.purpose === 'initial') for (const window of placementWindowCandidates(day.date, task.radius)) {
        if (day.date >= window.from && day.date <= window.through && (task.load !== 'heavy' || task.holidayPriority === false
          || !task.radius || !input.holidaysConfigured || configuredDays.some(other => other.holiday && other.date >= window.from && other.date <= window.through))) { initialDisplay = window; break; }
      }
      if (task.purpose === 'initial' && !initialDisplay) return [];
      const load = readLoad(day.date);
      if (load.heavy + Number(task.load === 'heavy') > day.heavyLimit || load.normal + Number(task.load === 'normal') > day.normalLimit) return [];
      const windows = allAllowed.flatMap(span => {
        const start = Math.max(span.start, day.bounds.start, day.date === input.today ? input.now : -Infinity);
        return start < span.end && start < day.bounds.end ? [{ start, end: span.end }] : [];
      });
      const choices = [];
      for (const free of subtractInstantSpans(windows, reserved)) {
        // A continuous band may cross midnight. Daily caps can make a later
        // start feasible even when its first 30 minutes do not fit today's cap.
        const starts = new Set([free.start, ...configuredDays.filter(other => other.bounds.end > free.start
          && other.bounds.start < Math.min(free.end, day.bounds.end + minutes * minute))
          .map(other => other.bounds.end - Math.max(0, capacity(other) - readLoad(other.date).minutes) * minute)]);
        if (task.weatherSensitive && weather) for (const boundary of weather.boundaries) if (boundary >= free.start && boundary < free.end) starts.add(boundary);
        for (const start of [...starts].sort((a, b) => a - b)) {
        const slot = { start, end: start + minutes * minute };
        if (slot.start < free.start || slot.end > free.end || slot.start >= day.bounds.end) continue;
        const portions = charges({ roundId: task.id, date: day.date, minutes: task.minutes, load: task.load, slot });
        const represented = portions.reduce((sum, part) => sum + part.minutes, 0);
        if (Math.abs(represented - minutes) > 1e-7 || portions.some(part => readLoad(part.day.date).minutes + part.minutes > capacity(part.day) + 1e-7)) continue;
        const own = portions.find(part => part.day.date === day.date)?.minutes ?? 0;
        const suitability = task.weatherSensitive ? weather?.evaluate(slot.start, slot.end).suitable : null;
        if (task.weatherSensitive && suitability === false) continue;
        choices.push({ day, slot, initialDisplay, score: [(load.minutes + own) / capacity(day), load.heavy + Number(task.load === 'heavy'),
          load.normal + Number(task.load === 'normal'), load.count + 1] });
        break;
        }
        if (choices.length) break;
      }
      return choices.slice(0, 1);
    });
  }
  const available = tasks.filter(task => !result.has(task.id));
  const initialCounts = new Map(available.map(task => [task.id, optionsFor(task).length]));
  const loadOrder = { heavy: 0, normal: 1, light: 2 };
  available.sort((a, b) => initialCounts.get(a.id)! - initialCounts.get(b.id)! || loadOrder[a.load] - loadOrder[b.load]
    || (b.minutes ?? 0) - (a.minutes ?? 0) || a.choreId.localeCompare(b.choreId) || a.id.localeCompare(b.id));
  for (const task of available) {
    const choices = optionsFor(task); let selected: typeof choices[number] | undefined; let chosen: WindowCandidate | undefined;
    for (const window of task.windows) {
      const candidates = choices.filter(choice => choice.day.date >= window.from && choice.day.date <= window.through);
      candidates.sort((a, b) => {
        for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return a.score[i] - b.score[i];
        return Number(task.load === 'heavy' && task.holidayPriority !== false && b.day.holiday) - Number(task.load === 'heavy' && task.holidayPriority !== false && a.day.holiday)
          || Math.abs(daysBetween(task.baseDate, a.day.date)) - Math.abs(daysBetween(task.baseDate, b.day.date))
          || Number(b.day.date === task.previous?.recommendedDate) - Number(a.day.date === task.previous?.recommendedDate)
          || a.day.date.localeCompare(b.day.date);
      });
      if (candidates.length) { selected = candidates[0]; chosen = window; break; }
    }
    const basicWindow = task.radius ? { from: addDays(task.baseDate, -task.radius), through: addDays(task.baseDate, task.radius) } : null;
    let plan: AdaptiveRoundPlacement;
    if (selected && chosen) {
      const displayed = selected.initialDisplay ?? chosen;
      plan = { id: task.id, originalBaseDate: task.baseDate, placedBaseDate: displayed.base,
      recommendedDate: selected.day.date, basicWindow, displayedWindow: task.radius ? { from: displayed.from, through: displayed.through } : null,
      slot: selected.slot, fallback: false };
    }
    else if (task.previous && (task.baseDate < input.today || task.purpose === 'automatic' && task.baseDate <= tomorrow)) plan = { ...task.previous };
    else {
      if (task.lastCompletedDate && task.baseDate <= task.lastCompletedDate) throw new Error('次回は実施日より後にしてください。');
      plan = { id: task.id, originalBaseDate: task.baseDate, placedBaseDate: task.baseDate, recommendedDate: task.baseDate,
        basicWindow, displayedWindow: basicWindow, slot: null, fallback: true };
    }
    if (task.minutes === null) plan = { ...plan, slot: null };
    result.set(task.id, plan); reserve({ roundId: task.id, date: plan.recommendedDate, minutes: task.minutes, load: task.load, slot: plan.slot });
  }
  return input.tasks.map(task => result.get(task.id)!);
}
