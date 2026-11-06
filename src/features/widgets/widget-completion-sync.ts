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
      for (const id of new Set([...pendingIds, ...requestedIds])) {
        const entry = snapshot.scheduleEntries.find((candidate) => candidate.id === id);
        if (!entry || snapshot.completions.some((completion) => completionMatchesEntry(completion, entry))) continue;
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
