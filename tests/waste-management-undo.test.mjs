import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
const repository = await import('../src/platform/storage/repository.ts');
for (const platform of ['ios', 'android']) test(`${platform} waste management can undo deletion with hidden dates and undo hiding one occurrence`, async () => {
  const h = createDatabase(); let screen;
  try {
    await repository.initializeLocalDatabase(h.database);
    await repository.saveWeeklyWasteSchedule(h.database, { id: 'undo-waste', label: '可燃ごみ', recurrence: 'weekly', collectionWeekdays: [1] });
    await repository.setWasteOccurrenceHidden(h.database, 'undo-waste', '2026-11-02', true);
    let snapshot = await repository.loadPlannerSnapshot(h.database, '2026-11-01');
    const refresh = async () => { snapshot = await repository.loadPlannerSnapshot(h.database, '2026-11-01'); };
    screen = screenHarness('src/app/waste.tsx', { platform, database: h.database, snapshot: () => snapshot, refresh,
      effectDependencies: true, effect: callback => callback() });
    await screen.press('削除');
    assert.equal(snapshot.wasteSchedules.length, 0);
    await screen.press('可燃ごみを元に戻す');
    assert.equal(snapshot.wasteSchedules[0].id, 'undo-waste');
    assert.ok(snapshot.hiddenWasteOccurrenceKeys.includes('undo-waste:2026-11-02'));
    await screen.press('再表示');
    assert.ok(!snapshot.hiddenWasteOccurrenceKeys.includes('undo-waste:2026-11-02'));
    await screen.press('可燃ごみを元に戻す');
    assert.ok(snapshot.hiddenWasteOccurrenceKeys.includes('undo-waste:2026-11-02'));
    assert.equal(snapshot.wasteSchedules.length, 1);
  } finally { screen?.unmount(); h.connection.close(); }
});
test('waste Undo can retry a failed durable restore without duplicating successful writes', async () => {
  const h = createDatabase(); let screen;
  try {
    await repository.initializeLocalDatabase(h.database);
    await repository.saveWeeklyWasteSchedule(h.database, { id: 'retry-waste', label: 'びん', collectionWeekdays: [1] });
    let snapshot = await repository.loadPlannerSnapshot(h.database, '2026-11-01'); let attempts = 0;
    screen = screenHarness('src/app/waste.tsx', { database: h.database, snapshot: () => snapshot,
      refresh: async () => { snapshot = await repository.loadPlannerSnapshot(h.database, '2026-11-01'); },
      mocks: { '@/platform/storage/repository': { ...repository, restoreDeletedWasteSchedule: async (...args) => { if (++attempts === 1) throw new Error('保存できません'); return repository.restoreDeletedWasteSchedule(...args); } } },
      effectDependencies: true, effect: callback => callback() });
    await screen.press('削除'); await screen.press('びんを元に戻す');
    assert.equal(snapshot.wasteSchedules.length, 0); assert.match(screen.text(), /保存できません/);
    await screen.press('びんを元に戻す'); assert.equal(snapshot.wasteSchedules.length, 1); assert.equal(attempts, 2);
    assert.ok(!screen.nodes().some(node => node.props.accessibilityLabel === 'びんを元に戻す'));
  } finally { screen?.unmount(); h.connection.close(); }
});


for (const recurrence of ['weekly', 'biweekly', 'monthly']) test(`waste ${recurrence} Undo does not expire while refresh or failed restoration prevents input`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = createDatabase(); let screen; t.after(() => { screen?.unmount(); h.connection.close(); });
  await repository.initializeLocalDatabase(h.database);
  const rule = { id: 'slow-undo', label: 'びん', recurrence,
    collectionWeekdays: recurrence === 'monthly' ? [] : [1],
    ...(recurrence === 'biweekly' ? { anchorDate: '2026-11-02' } : {}), ...(recurrence === 'monthly' ? { monthlyDay: 2 } : {}) };
  await repository.saveWeeklyWasteSchedule(h.database, rule);
  await repository.setWasteOccurrenceHidden(h.database, rule.id, '2026-11-02', true);
  let snapshot = await repository.loadPlannerSnapshot(h.database, '2026-11-01'); let release; let began; let refreshCount = 0; let refreshed; let retryEntered;
  const retryRefreshing = new Promise(resolve => { retryEntered = resolve; });
  const refreshedAgain = new Promise(resolve => { refreshed = resolve; });
  const entered = new Promise(resolve => { began = resolve; }); let restoring; let restoreBegan; let attempts = 0;
  const enteredRestore = new Promise(resolve => { restoreBegan = resolve; });
  screen = screenHarness('src/app/waste.tsx', { database: h.database, snapshot: () => snapshot,
    refresh: async () => { refreshCount++; await new Promise(resolve => { release = resolve; if (refreshCount === 1) began(); else retryEntered(); }); snapshot = await repository.loadPlannerSnapshot(h.database, '2026-11-01'); if (refreshCount === 2) refreshed(); },
    mocks: { '@/platform/storage/repository': { ...repository, restoreDeletedWasteSchedule: async (...args) => {
      if (++attempts === 1) { restoreBegan(); await new Promise(resolve => { restoring = resolve; }); throw new Error('synthetic restore unavailable'); }
      return repository.restoreDeletedWasteSchedule(...args);
    } } }, effectDependencies: true, effect: callback => callback() });
  const removing = screen.press('削除'); await entered; screen.render();
  assert.equal(screen.button('びんを元に戻す').props.disabled, true);
  t.mock.timers.tick(20_000); screen.render();
  assert.ok(screen.button('びんを元に戻す'));
  release(); await removing; screen.render();
  assert.equal(screen.button('びんを元に戻す').props.disabled, false);
  t.mock.timers.tick(1000);
  const undoing = screen.press('びんを元に戻す'); await enteredRestore; screen.render();
  t.mock.timers.tick(20_000); screen.render(); restoring(); await undoing; screen.render();
  assert.match(screen.text(), /synthetic restore unavailable/); assert.ok(screen.button('びんを元に戻す'));
  const retry = screen.press('びんを元に戻す'); await retryRefreshing;
  release(); await refreshedAgain; await retry; await screen.flush();
  assert.equal(snapshot.wasteSchedules[0].id, rule.id); assert.ok(snapshot.hiddenWasteOccurrenceKeys.includes('slow-undo:2026-11-02'));
  assert.equal(attempts, 2); assert.equal(h.connection.prepare('SELECT count(*) n FROM deleted_waste_schedules').get().n, 0);
});
