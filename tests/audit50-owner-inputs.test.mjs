import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sharedAdaptiveLoad } from '../src/features/planner/shared-adaptive-load.ts';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readPersonalSettingsView } = await import('../src/platform/storage/personal-settings-view.ts');

test('audit50 a fixed shared clock reserves its actual interval even when the chore has no estimated duration', () => {
  const target = { precision: 'interval', start: '2026-11-07T00:00:00Z', end: '2026-11-07T01:00:00Z' };
  const plan = { initialized: true, groupId: 'group', members: [{ userId: 'owner', active: true }],
    chores: [{ id: 'chore', name: '共有', enabled: true, load: 'normal' }], history: [],
    occurrences: [{ choreId: 'chore', activeInPeriod: true, assigneeIds: ['owner'], subjects: [{ id: 'round', required: true, subjectUserId: null, suggestedDate: '2026-11-07', formalDate: { kind: 'manual', mode: 'fixed', target } }] }] };
  const [load] = sharedAdaptiveLoad(plan, 'owner', '2026-11-07', 'Asia/Tokyo', []).loads;
  assert.deepEqual(load.slot, { start: Date.parse(target.start), end: Date.parse(target.end) }); assert.equal(load.minutes, 60);
});

test('audit50 personal settings do not transfer or parse retired definition bodies that are needed only by history', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const current = JSON.parse(h.connection.prepare('SELECT definition_json FROM chore_definitions LIMIT 1').get().definition_json);
  for (let n = 0; n < 1000; n++) await h.database.runAsync('INSERT INTO chore_definitions(id,household_id,name,enabled,definition_json) VALUES(?,?,?,?,?)', `retired-${n}`, 'local-household', 'retired', 0, JSON.stringify({ ...current, id: `retired-${n}`, archived: true, description: 'old'.repeat(2000) }));
  const query = h.database.getAllAsync.bind(h.database); let bytes = 0;
  h.database.getAllAsync = async (...args) => { const rows = await query(...args); bytes += JSON.stringify(rows).length; return rows; };
  const view = await readPersonalSettingsView(h.database);
  assert.ok(view.chores.every(chore => !chore.archived)); assert.ok(bytes < 1_000_000, `settings bridge characters: ${bytes}`);
  assert.equal(h.connection.prepare("SELECT count(*) n FROM chore_definitions WHERE id LIKE 'retired-%'").get().n, 1000, 'historical definitions remain stored');
});
