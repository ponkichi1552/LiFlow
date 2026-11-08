import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const today = '2026-11-08';

for (const platform of ['ios', 'android']) test(`${platform} personal Home folds only expired pending work and preserves expansion across snapshot refresh`, async t => {
  const h = createDatabase(); t.after(() => h.connection.close());
  await repository.initializeLocalDatabase(h.database); const base = await repository.loadPlannerSnapshot(h.database, today);
  const chores = base.chores.slice(0, 3).map((row, index) => ({ ...row, enabled: true, name: ['期限当日', '期限切れ', '通常'][index] }));
  const entries = chores.map((row, index) => ({ id: `fold-${index}`, choreId: row.id, householdId: row.householdId,
    cycleBaseDate: '2026-11-06', suggestedDate: '2026-11-07', windowStart: '2026-11-06', windowEnd: index === 1 ? '2026-11-07' : index === 0 ? today : '2026-11-10', assignedMemberIds: [], status: 'inWindow' }));
  let snapshot = { ...base, today, chores, scheduleEntries: entries, completions: [], upcomingWasteDates: [], settings: { ...base.settings, setupCompleted: true } };
  const kv = { getItemSync: () => null, setItemSync() {} };
  const screen = screenHarness('src/app/(tabs)/index.tsx', { platform, database: h.database, snapshot: () => snapshot,
    mocks: { 'expo-sqlite/kv-store': { __esModule: true, default: kv } } }); t.after(() => screen.unmount());
  const labels = () => screen.nodes().filter(row => row.props.accessibilityRole === 'checkbox').map(row => row.props.accessibilityLabel);
  assert.ok(labels().includes('期限当日を完了')); assert.ok(labels().includes('通常を完了'));
  assert.equal(labels().includes('期限切れを完了'), false);
  assert.equal(screen.button('期限を過ぎた家事（1件）を開く').props.accessibilityState.expanded, false);
  await screen.press('期限を過ぎた家事（1件）を開く'); assert.ok(labels().includes('期限切れを完了'));
  snapshot = { ...snapshot, scheduleEntries: entries.map(row => ({ ...row })) }; await screen.flush();
  assert.ok(labels().includes('期限切れを完了')); assert.equal(screen.button('期限を過ぎた家事（1件）を閉じる').props.accessibilityState.expanded, true);
  await screen.press('期限を過ぎた家事（1件）を閉じる'); assert.equal(labels().includes('期限切れを完了'), false);
});
