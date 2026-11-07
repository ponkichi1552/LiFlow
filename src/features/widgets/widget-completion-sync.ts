import type { ChoreCompletion, ChoreScheduleEntry } from '@/domain/chores/types';
import { completionMatchesEntry } from '@/domain/scheduling/completion-matching';

interface WidgetPlannerData {
  scheduleEntries: readonly ChoreScheduleEntry[];
  completions: readonly ChoreCompletion[];
}

export function createWidgetCompletionSync<Snapshot extends WidgetPlannerData>(dependencies: {
  load(preferCached?: boolean): Promise<Snapshot>;
  pendingIds(): Promise<readonly string[]>;
  complete(entry: ChoreScheduleEntry): Promise<boolean>;
  publish(snapshot: Snapshot): void | Promise<void>;
}) {
  let queue: Promise<unknown> = Promise.resolve();
  return (requestedIds: readonly string[] = [], options: { publish?: boolean; preferCached?: boolean; ignorePending?: boolean } = {}): Promise<{ snapshot: Snapshot; canPublishWidget: boolean }> => {
    const operation = queue.then(async () => {
      let canPublishWidget = true;
      let pendingIds: readonly string[] = [];
      try {
        if (!options.ignorePending) pendingIds = await dependencies.pendingIds();
      } catch {
        // Keep unacknowledged widget actions until the native timeline can be read.
        canPublishWidget = false;
      }
      let snapshot = await dependencies.load(pendingIds.length || requestedIds.length ? false : options.preferCached);
      let attempted = false;
      const ids = new Set([...pendingIds, ...requestedIds]);
      const byId = new Map<string, ChoreScheduleEntry>();
      const completed = new Set<string>();
      const legacy = new Map<string, ChoreCompletion[]>();
      if (ids.size) {
        for (const entry of snapshot.scheduleEntries) if (!byId.has(entry.id)) byId.set(entry.id, entry);
        for (const fact of snapshot.completions) if (fact.outcome === 'completed') {
          if (fact.scheduleEntryId) completed.add(JSON.stringify([fact.choreId, fact.scheduleEntryId]));
          else { const rows = legacy.get(fact.choreId) ?? []; rows.push(fact); legacy.set(fact.choreId, rows); }
        }
      }
      for (const id of ids) {
        const entry = byId.get(id);
        if (!entry || completed.has(JSON.stringify([entry.choreId, entry.id]))
          || legacy.get(entry.choreId)?.some(fact => completionMatchesEntry(fact, entry))) continue;
        attempted = true;
        try {
          await dependencies.complete(entry);
        } catch {
          canPublishWidget = false;
        }
      }
      if (attempted) snapshot = await dependencies.load();
      if (canPublishWidget && options.publish !== false) {
        try { await dependencies.publish(snapshot); } catch { canPublishWidget = false; }
      }
      return { snapshot, canPublishWidget };
    });
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  };
}
