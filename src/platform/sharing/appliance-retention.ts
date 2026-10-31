import { openDatabaseAsync } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { createV2EventRepository } from '../storage/sharing-v2-events';
import { initializeLocalDatabase } from '../storage/repository';
import { retainSharedApplianceCopies } from '../storage/appliance-manuals';
import { readV2Appliance } from '../../features/sharing/v2/appliance-state';
import { readV2ManualDocument } from '../../features/sharing/v2/manual-documents';
import { v2ReadPoint } from '../../features/sharing/v2/view-point';
import { notifyApplianceLibraryChanges } from '../../features/appliance-care/library-changes';

/** No paid API, credentials, private chores or settings cross this boundary. */
export function createNativeApplianceRetention(input: { database: SQLiteDatabase; repository: ReturnType<typeof createV2EventRepository>;
  assertAccess(): void | Promise<void> }) {
  let completed: string | undefined; let running: Promise<void> | undefined; let again = false;
  const refresh = (): Promise<void> => {
    if (running) { again = true; return running; }
    const work = async () => {
      do {
        again = false; await input.assertAccess();
        const rows = await input.database.getAllAsync<{ operation_id: string }>("SELECT operation_id FROM sharing_operations WHERE group_id=? AND CASE WHEN json_valid(operation_json) THEN json_extract(operation_json, '$.entityType') ELSE NULL END IN (?, ?) ORDER BY operation_id", input.repository.scope.groupId, 'appliance', 'manualDocument');
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
        await input.assertAccess();
        if (copies.length) {
          const personal = await openDatabaseAsync('housework.db', { useNewConnection: true });
          try {
            await input.assertAccess(); await initializeLocalDatabase(personal); await input.assertAccess();
            if (await retainSharedApplianceCopies(personal, input.repository.scope.groupId, copies, input.assertAccess)) notifyApplianceLibraryChanges();
          } finally { await personal.closeAsync(); }
        }
        completed = token;
      } while (again);
    };
    const task = work(); running = task;
    void task.finally(() => { if (running === task) running = undefined; }).catch(() => undefined);
    return task;
  };
  return { refresh };
}
