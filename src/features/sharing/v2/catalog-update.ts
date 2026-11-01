import { BUILT_IN_CHORE_CATALOG_VERSION, createHouseholdChoreDefinitions } from '../../../domain/chores/catalog.ts';
import { builtInCatalogPatch } from '../../../domain/chores/catalog-upgrade.ts';
import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger.ts';
import { sharedPatchFromDefinition } from '../planning.ts';
import type { JsonValue } from '../operations.ts';
import { v2ReadPoint } from './view-point.ts';
import { V2HistoryConflictError } from './history-view.ts';

/** One owner-authored catalog update; edits, policies, completion IDs and deleted jobs are never replaced. */
export async function ensureV2CatalogCurrent(repository: ReturnType<typeof createV2EventRepository>, makeId: () => string): Promise<boolean> {
  const version = await repository.withPrivateStorage(async transaction =>
    transaction.getFirstAsync<{ catalog_version: number }>('SELECT catalog_version FROM sharing_v2_catalog_state WHERE singleton=1'));
  if ((version?.catalog_version ?? 0) >= BUILT_IN_CHORE_CATALOG_VERSION) return true;
  let ready = false;
  await repository.commitCurrent(async (state, transaction) => {
    const roster = state.archive.at(-1)!;
    if (roster.body.ownerUserId !== repository.scope.userId) return [];
    const view = state.assessment.view; const at = v2ReadPoint(view, roster);
    if (view.field('settings', 'settings', '$alive', at)?.value !== true || !view.ofType('groupPolicy').length) return [];
    const drafts: SharedOperationDraft[] = [];
    const builtIns = view.ofType('chore').some(op => op.authorUserId === roster.body.ownerUserId
      && op.entityId.startsWith(`${repository.scope.groupId}.builtin-chore-`));
    if (builtIns) for (const definition of createHouseholdChoreDefinitions(repository.scope.householdId)) {
      const id = `${repository.scope.groupId}.${definition.id}`;
      const facts = view.topic('chore', id);
      if (!facts.length) {
        drafts.push({ operationId: makeId(), entityType: 'chore', entityId: id, operationType: 'patch',
          payload: { ...sharedPatchFromDefinition({ ...definition, id, enabled: false }), requiresCycleSelection: true } });
        continue;
      }
      try {
        if (view.field('chore', id, '$alive', at)?.value !== true) continue;
        const fields = new Set(facts.flatMap(fact => Object.keys(fact.payload)));
        const existing = Object.fromEntries([...fields].map(field => [field, view.field('chore', id, field, at)?.value]));
        const patch = builtInCatalogPatch(existing, { ...definition, id });
        if (Object.keys(patch).length) drafts.push({ operationId: makeId(), entityType: 'chore', entityId: id, operationType: 'patch',
          payload: Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value])) as Record<string, JsonValue> });
      } catch (error) { if (!(error instanceof V2HistoryConflictError)) throw error; }
    }
    await transaction.runAsync('INSERT INTO sharing_v2_catalog_state (singleton, catalog_version) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET catalog_version=excluded.catalog_version', BUILT_IN_CHORE_CATALOG_VERSION);
    ready = true;
    return drafts;
  });
  return ready;
}
