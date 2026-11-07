import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const coordinator = await import('../src/features/google-sync/coordinator.ts');
const { createGoogleOperationBudget } = await import('../src/features/google-sync/operation-budget.ts');

test('audit100 stopping Tasks during an active HTTP pass remains OFF after that pass settles', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await repository.initializeLocalDatabase(h.database);
  const now = new Date('2026-11-07T03:00:00Z');
  await repository.saveGoogleSyncState(h.database, { householdId: 'local-household', accountSubject: 'account', enabled: true, taskListId: 'list', status: 'idle', retryCount: 0, updatedAt: now.toISOString() });
  let release, entered; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const budget = createGoogleOperationBudget(10000); t.after(() => budget.close());
  const run = coordinator.syncGoogleTasksWithDependencies({ syncScope: h.database, budget,
    loadState: () => repository.loadGoogleSyncState(h.database), saveState: state => repository.saveGoogleSyncState(h.database, state), getAccessToken: async () => 'synthetic-token',
    listEntriesForGoogleSync: async () => [], listGoogleTaskLinks: async () => [], importGoogleTaskChanges: async () => 0,
    api: { listTaskLists: async () => [{ id: 'list', title: '家事Planner' }], listTasks: async () => { entered(); await gate; return []; } },
  }, { now, force: true });
  await started;
  const stopped = coordinator.configurePersonalGoogleTaskSync(h.database, false);
  release(); await run; await stopped;
  assert.equal((await repository.loadGoogleSyncState(h.database)).enabled, false);
});
