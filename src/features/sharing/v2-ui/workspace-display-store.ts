import type { V2GroupUiSession } from './screen-session';
import { sharedLocalDate } from '../group-clock.ts';
import { traceStartup } from '../../../platform/diagnostics/startup-timing.ts';
import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import { v2CalendarMonth } from './calendar-projection.ts';
import { v2CalendarDisplayRange } from './calendar-range.ts';

type Options = Parameters<V2GroupUiSession['readModel']>[0];
type Model = Awaited<ReturnType<V2GroupUiSession['readModel']>>;
export interface WorkspaceDisplayValue { session: V2GroupUiSession; model: Model }

function commonDisplay(options: Options) {
  return !options || (!options.focusDate && !options.detailChoreId && !options.choreSettings && !options.groupPolicy
    && !options.permissionsChoreId && !options.applianceId && !options.reminders);
}

/** Reuse only a fully covered presentation; editing still takes its own authority read. */
function coversDisplay(value: WorkspaceDisplayValue, options: Options) {
  if (!commonDisplay(options) || !value.model.waste || !value.model.appliances) return false;
  const { model } = value; const date = model.plan.range.asOfDate;
  try {
    if (options?.calendarRange && !options.calendarMonth) return false;
    const calendar = options?.calendarMonth ? v2CalendarMonth(options.calendarMonth === 'current' ? date : options.calendarMonth as typeof date) : null;
    const range = calendar ? options?.calendarRange ?? v2CalendarDisplayRange(calendar.month) : { from: addDays(date, -14), through: addDays(date, 14) };
    parseLocalDate(range.from); parseLocalDate(range.through);
    if (range.from > range.through || range.through > addDays(range.from, 366)
      || calendar && (range.from > calendar.from || range.through < calendar.through)) return false;
    const contains = (actual: { from: string; through: string }) => actual.from <= range.from && actual.through >= range.through;
    return contains(model.plan.range) && contains(model.waste!.range)
      && (model.privateOverlay?.status !== 'ready' || contains(model.privateOverlay.range));
  } catch { return false; }
}

/** The four main tabs share one prepared view; editing keeps its own authority read. */
export function workspaceDisplayOptions(options: Options): Options {
  // The first home must not wait for several months of calendar preparation.
  return commonDisplay(options) ? { calendarMonth: options?.calendarMonth, calendarRange: options?.calendarRange, waste: true, appliances: true } : options;
}

/** Memory-only, bounded, and owned by one authenticated workspace/provider lifetime. */
export function createWorkspaceDisplayStore(initialLoad?: () => Promise<V2GroupUiSession>, now: () => Date = () => new Date()) {
  let load = initialLoad;
  let generation = 0; let disposed = false;
  const values = new Map<string, WorkspaceDisplayValue & { generation: number }>();
  const pending = new Map<string, Promise<WorkspaceDisplayValue>>(); const listeners = new Set<() => void>();
  const key = (options: Options) => JSON.stringify(workspaceDisplayOptions(options) ?? {});
  const notify = () => { for (const listener of listeners) listener(); };
  const fresh = (value: WorkspaceDisplayValue & { generation: number }) => value.generation === generation
    && sharedLocalDate(now(), value.model.plan.timeZone) === value.model.plan.range.asOfDate
    && (value.model.privateOverlay?.status !== 'ready' || sharedLocalDate(now(), value.model.privateOverlay.timeZone) === value.model.privateOverlay.today);
  const covering = (options: Options) => [...values.values()].reverse().find(value => fresh(value) && coversDisplay(value, options));
  const store = {
    bind(loader: () => Promise<V2GroupUiSession>) { load = loader; },
    peek(options?: Options): WorkspaceDisplayValue | undefined { return disposed ? undefined : values.get(key(options)) ?? covering(options); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    invalidate() { generation++; },
    async read(options?: Options): Promise<WorkspaceDisplayValue> {
      if (disposed) throw new Error('表示するアカウント・グループが変わりました。');
      const normalized = workspaceDisplayOptions(options); const cacheKey = key(normalized);
      // Access is checked even for a prepared display. Cache identity is never an authorization token.
      if (!load) throw new Error('共有表示の準備が完了していません。');
      const source = await traceStartup('display.access', load);
      if (disposed) throw new Error('表示するアカウント・グループが変わりました。');
      const current = values.get(cacheKey);
      if (current && fresh(current)) return current;
      const retained = covering(normalized); if (retained) return retained;
      const existing = pending.get(cacheKey); if (existing) return existing;
      const work = (async () => {
        let revision: number; let model: Model;
        do { revision = generation; model = await traceStartup(normalized?.management ? 'display.settings' : 'display.plan', () => source.readModel(normalized)); }
        while (!disposed && revision !== generation);
        if (disposed) throw new Error('表示するアカウント・グループが変わりました。');
        const session: V2GroupUiSession = { ...source, invalidate: store.invalidate,
          readModel: async next => (await store.read(next)).model };
        const value = { session, model, generation: revision };
        values.delete(cacheKey); values.set(cacheKey, value);
        while (values.size > 6) values.delete(values.keys().next().value!);
        notify(); return value;
      })();
      pending.set(cacheKey, work);
      try { return await work; } finally { if (pending.get(cacheKey) === work) pending.delete(cacheKey); }
    },
    dispose() { disposed = true; generation++; values.clear(); listeners.clear(); },
  };
  return store;
}
