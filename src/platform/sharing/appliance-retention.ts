import { openDatabaseAsync } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { createV2EventRepository } from '../storage/sharing-v2-events';
import { initializeLocalDatabase } from '../storage/repository';
import { retainSharedApplianceCopies } from '../storage/appliance-manuals';
import { readV2Appliance } from '../../features/sharing/v2/appliance-state';
import { readV2ManualDocument } from '../../features/sharing/v2/manual-documents';
import { v2ReadPoint } from '../../features/sharing/v2/view-point';
import { notifyApplianceLibraryChanges } from '../../features/appliance-care/library-changes';
import type { V2ApplianceReviewResult } from '../../features/sharing/v2/appliance-actions';

/** A retained-copy failure does not undo the signed save. Existing replica facts
 * and copy fingerprints are the durable retry source on sync or the next launch. */
export async function reviewWithPersonalApplianceRetention(review: () => Promise<V2ApplianceReviewResult>,
  retention: { refresh(): Promise<void> }, assertAccess: () => void | Promise<void>): Promise<V2ApplianceReviewResult> {
  await assertAccess(); const saved = await review(); let personalRetentionPending = false;
  try { await retention.refresh(); } catch { personalRetentionPending = true; }
  // Never return the old account's product data through a replaced session.
  await assertAccess();
  return { ...saved, personalRetentionPending };
}

/** No paid API, credentials, private chores or settings cross this boundary. */
export function createNativeApplianceRetention(input: { database: SQLiteDatabase; repository: ReturnType<typeof createV2EventRepository>;
  assertAccess(): void | Promise<void> }) {
  let completed: string | undefined; let running: Promise<void> | undefined; let again = false; let deadline = Infinity;
  const refresh = (budgetMs?: number): Promise<void> => {
    const requestedDeadline = budgetMs === undefined ? Infinity : Date.now() + budgetMs;
    if (running) { deadline = Math.min(deadline, requestedDeadline); again = true; return running; }
    deadline = requestedDeadline;
    const guard = async () => { await input.assertAccess(); if (Date.now() >= deadline) throw new Error('家電の保存は次回同期で続けます。'); };
    const work = async () => {
      do {
        again = false; await guard();
        const rows = await input.database.getAllAsync<{ operation_id: string }>("SELECT operation_id FROM sharing_operations WHERE group_id=? AND CASE WHEN json_valid(operation_json) THEN json_extract(operation_json, '$.entityType') ELSE NULL END IN (?, ?, ?) ORDER BY operation_id", input.repository.scope.groupId, 'appliance', 'manualDocument', 'manualChunk');
        const snapshot = await input.database.getFirstAsync<{ snapshot_id: string }>('SELECT snapshot_id FROM sharing_snapshot_state WHERE group_id=?', input.repository.scope.groupId);
        if (!rows.length && !snapshot) { completed = '[]'; continue; }
        const projection = await input.database.getFirstAsync<{ accepted_ids_json: string }>('SELECT accepted_ids_json FROM sharing_v2_projection WHERE singleton=1');
        const accepted = new Set<string>(JSON.parse(projection?.accepted_ids_json ?? '[]'));
        const token = JSON.stringify([snapshot?.snapshot_id ?? null, rows.filter(row => accepted.has(row.operation_id)).map(row => row.operation_id)]); if (token === completed) continue;
        const copies = await input.repository.readCurrent(async state => {
          const view = state.assessment.view; const at = v2ReadPoint(view, state.archive.at(-1)!);
          return [...new Set(view.ofType('appliance').map(op => op.entityId))].flatMap(id => {
            const { appliance } = readV2Appliance(view, at, id); if (!appliance) return [];
            const digest = appliance.analysis.manualSource?.sha256;
            return [{ appliance, manual: digest ? readV2ManualDocument(view, at, digest) : null }];
          });
        });
        await guard();
        if (copies.length) {
          const personal = await openDatabaseAsync('housework.db', { useNewConnection: true });
          try {
            await guard(); await initializeLocalDatabase(personal); await guard();
            if (await retainSharedApplianceCopies(personal, input.repository.scope.groupId, copies, guard)) notifyApplianceLibraryChanges();
          } finally { await personal.closeAsync(); }
        }
        completed = token;
      } while (again);
    };
    const task = work(); running = task;
    void task.finally(() => { if (running === task) { running = undefined; deadline = Infinity; } }).catch(() => undefined);
    return task;
  };
  return { refresh };
}
