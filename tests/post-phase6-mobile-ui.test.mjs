import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { homeSummary, nextHomeClockDelay } from '../src/features/planner/home-summary.ts';
import { orderDateTasks } from '../src/domain/scheduling/date-tasks.ts';
import { createTaskMutations } from '../src/features/planner/task-mutations.ts';
import { createChoreSettingsDocument } from '../src/features/settings/chore-settings-editor.ts';
import { privateOverlayPendingCounts } from '../src/features/sharing/v2-ui/private-overlay.ts';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const today = '2026-10-29';
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const pending = (id = 'floor') => ({ id, choreId: id, completed: false, suggestedDate: today,
  entry: { id, choreId: id, householdId: 'local-household', cycleBaseDate: today, suggestedDate: today, windowStart: today, windowEnd: today, assignedMemberIds: [], status: 'inWindow' } });

test('home greeting changes at 19 only for zero chores or all completed and hides empty progress', () => {
  for (const total of [0, 4]) for (const time of ['18:59:59', '19:00:00', '23:59:59', '00:00:00']) {
    const summary = homeSummary(total, total, new Date(`2026-10-29T${time}+09:00`), 'Asia/Tokyo');
    assert.equal(summary.greeting, time >= '19:00:00' ? '今日も1日お疲れ様でした' : '今日も1日頑張りましょう');
    assert.equal(summary.showProgress, total > 0);
  }
  assert.equal(homeSummary(4, 3, new Date('2026-10-29T23:00:00+09:00'), 'Asia/Tokyo').greeting, '今日も1日頑張りましょう');
  assert.equal(homeSummary(500, 499, new Date('2026-10-29T23:00:00+09:00'), 'Asia/Tokyo').percent, 99);
  assert.equal(homeSummary(4, 4, new Date('2026-10-29T18:00:00Z'), 'America/Los_Angeles').greeting, '今日も1日頑張りましょう');
  assert.equal(nextHomeClockDelay(new Date('2026-10-29T18:59:59+09:00'), 'Asia/Tokyo'), 1050);
  assert.equal(nextHomeClockDelay(new Date('2026-10-29T23:59:59+09:00'), 'Asia/Tokyo'), 1050);
  // DST ending at 02:00 must not create a fixed 24-hour timer.
  assert.equal(nextHomeClockDelay(new Date('2026-11-01T00:00:00-07:00'), 'America/Los_Angeles'), 20 * 3600_000 + 50);
});

test('home and calendar share all nine priority tiers and stable ties across completion undo and date selection', () => {
  const chores = []; const rows = [];
  for (const tier of ['urgent', 'pending', 'done']) for (const load of ['heavy', 'normal', 'light']) {
    const id = `${tier}-${load}`; chores.push({ id, load });
    rows.unshift({ ...pending(id), completed: tier === 'done', suggestedDate: tier === 'urgent' ? '2026-10-28' : today,
      entry: { ...pending(id).entry, windowEnd: '2026-10-31' } });
  }
  const expected = ['urgent-heavy', 'urgent-normal', 'urgent-light', 'pending-heavy', 'pending-normal', 'pending-light', 'done-heavy', 'done-normal', 'done-light'];
  const original = JSON.stringify(rows);
  assert.deepEqual(orderDateTasks(rows, today, chores).map(row => row.id), expected);
  assert.deepEqual(orderDateTasks([...rows].reverse(), '2026-11-06', chores, today).map(row => row.id), expected);
  assert.equal(JSON.stringify(rows), original);
  const notUrgent = [{ ...rows.find(row => row.id === 'urgent-light'), entry: { windowEnd: '2026-11-01' } }, rows.find(row => row.id === 'pending-heavy')];
  assert.equal(orderDateTasks(notUrgent, today, chores)[0].id, 'pending-heavy');
  const overdue = { ...pending('old'), suggestedDate: '2026-10-20', entry: { windowEnd: '2026-10-25' } };
  assert.equal(orderDateTasks([rows.find(row => row.id === 'pending-heavy'), overdue], today, [...chores, { id: 'old', load: 'light' }])[0].id, 'old');
});

for (const platform of ['ios', 'android']) test(`${platform} home progress hides percent until the first completion without hiding the chore count`, () => {
  const props = { total: 4, done: 0, summary: homeSummary(4, 0, new Date('2026-10-31T10:00:00+09:00'), 'Asia/Tokyo') };
  const screen = screenHarness('src/components/home-ui.tsx', { exportName: 'HomeProgress', platform, props });
  assert.match(screen.text(), /4件中0件が完了しました/u); assert.equal(screen.text().includes('%'), false);
  props.done = 1; props.summary = homeSummary(4, 1, new Date('2026-10-31T10:00:00+09:00'), 'Asia/Tokyo'); screen.render();
  assert.match(screen.text(), /4件中1件が完了しました/u); assert.match(screen.text(), /25%/u);
  props.done = 0; props.summary = homeSummary(4, 0, new Date('2026-10-31T10:00:00+09:00'), 'Asia/Tokyo'); screen.render();
  assert.equal(screen.text().includes('%'), false);
});

test('completion responds before slow storage and rejects same-frame duplicate taps without changing another occurrence', async () => {
  const write = deferred(); const read = deferred(); let writes = 0; let reads = 0;
  const task = pending(); const controller = createTaskMutations({ isCurrent: () => true, write: async () => { writes++; await write.promise; }, refresh: async () => { reads++; await read.promise; } });
  const running = controller.toggle(task); void controller.toggle(task);
  assert.equal(writes, 1); assert.equal(controller.project([task])[0].completed, true); assert.equal(task.completed, false);
  assert.equal(controller.project([{ ...task, id: 'next', entry: { ...task.entry, id: 'next' } }])[0].completed, false);
  write.resolve(); await delay(0); assert.equal(reads, 1); assert.equal(controller.getSnapshot().pending.size, 1);
  read.resolve(); await running; assert.equal(controller.getSnapshot().overrides.size, 0); assert.equal(controller.getSnapshot().pending.size, 0);
});

test('private calendar completion feedback adjusts only the original recommended day and never mutates the saved projection', () => {
  const rows = [{ key: 'early', date: '2026-10-28', suggestedDate: today, completed: false },
    { key: 'done', date: today, suggestedDate: today, completed: true }];
  const overlay = { counts: new Map([[today, 1]]), byDate: new Map([['2026-10-28', [rows[0]]], [today, [rows[1]]]]) };
  const values = new Map([['early', true], ['foreign', false]]);
  assert.equal(privateOverlayPendingCounts(overlay, values).get(today), 0);
  assert.equal(privateOverlayPendingCounts(overlay, values).get('2026-10-28') ?? 0, 0);
  assert.equal(overlay.counts.get(today), 1); assert.equal(rows[0].completed, false);
  values.set('done', false); assert.equal(privateOverlayPendingCounts(overlay, values).get(today), 1);
  assert.equal(privateOverlayPendingCounts(undefined, values).size, 0);
});

test('completion rolls back failed writes but keeps saved checks after read failure and retries only the read', async () => {
  let writes = 0; let failWrite = true; let failRead = true; const task = pending();
  const controller = createTaskMutations({ isCurrent: () => true, write: async () => { writes++; if (failWrite) throw new Error('保存失敗'); }, refresh: async () => { if (failRead) throw new Error('読込失敗'); } });
  await controller.toggle(task); assert.equal(controller.project([task])[0].completed, false); assert.equal(controller.getSnapshot().error, '保存失敗');
  failWrite = false; await controller.toggle(task); assert.equal(controller.project([task])[0].completed, true); assert.match(controller.getSnapshot().error, /保存済み/u);
  failRead = false; await controller.retryRead(); assert.equal(writes, 2); assert.equal(controller.getSnapshot().error, null); assert.equal(controller.getSnapshot().overrides.size, 0);
});

test('completion lifetime fences late refreshes and old handlers after a workspace switch', async () => {
  const write = deferred(); let writes = 0; let reads = 0;
  const controller = createTaskMutations({ isCurrent: () => true, write: async () => { writes++; await write.promise; }, refresh: async () => { reads++; } });
  const operation = controller.toggle(pending()); controller.deactivate(); write.resolve(); await operation; await controller.toggle(pending('other'));
  assert.equal(writes, 1); assert.equal(reads, 0);
});

test('failed render observers cannot swallow completion or autosave writes', async () => {
  let writes = 0;
  const controller = createTaskMutations({ isCurrent: () => true, write: async () => { writes++; }, refresh: async () => {} });
  controller.subscribe(() => { throw new Error('broken view'); });
  await controller.toggle(pending()); assert.equal(writes, 1); assert.equal(controller.getSnapshot().pending.size, 0);
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database); const chore = (await repository.loadPlannerSnapshot(h.database, today)).chores[0];
    const editor = createChoreSettingsDocument(h.database).get(chore, 'balanced', async () => { writes++; });
    editor.subscribe(() => { throw new Error('broken view'); }); editor.changeCycle('17');
    assert.equal(await editor.flush(), true); assert.equal(writes, 2);
  } finally { h.connection.close(); }
});

test('category enable disable is atomic and preserves individual cadence metadata completion history and unknown cycles', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [], previousDates: {}, weatherLocation: null });
    let snapshot = await repository.loadPlannerSnapshot(h.database, today);
    const rows = snapshot.chores.filter(row => !row.archived).slice(0, 3); const ids = rows.map(row => row.id);
    await repository.updateChoreSettings(h.database, ids[0], { cycleDays: 17 });
    await repository.setChoresEnabled(h.database, ids, true);
    snapshot = await repository.loadPlannerSnapshot(h.database, today);
    assert.equal(snapshot.chores.filter(row => ids.includes(row.id) && row.enabled).length, 3);
    assert.equal(snapshot.chores.find(row => row.id === ids[0]).recommendedCycleDays, 17);
    const entry = snapshot.scheduleEntries.find(row => row.choreId === ids[0]); await repository.completeChore(h.database, entry);
    await repository.setChoresEnabled(h.database, ids, false);
    snapshot = await repository.loadPlannerSnapshot(h.database, today); const history = JSON.stringify(snapshot.completions);
    assert.equal(snapshot.chores.filter(row => ids.includes(row.id) && row.enabled).length, 0); assert.equal(snapshot.completions.length, 1);
    await assert.rejects(repository.setChoresEnabled(h.database, [ids[0], 'foreign-chore'], true));
    snapshot = await repository.loadPlannerSnapshot(h.database, today); assert.equal(snapshot.chores.find(row => row.id === ids[0]).enabled, false);
    await repository.updateChoreDefinition(h.database, { ...rows[1], enabled: false, requiresCycleSelection: true });
    await assert.rejects(repository.setChoresEnabled(h.database, ids, true), /周期/u);
    snapshot = await repository.loadPlannerSnapshot(h.database, today);
    assert.equal(snapshot.chores.filter(row => ids.includes(row.id) && row.enabled).length, 0); assert.equal(JSON.stringify(snapshot.completions), history);
    await assert.rejects(repository.setChoresEnabled(h.database, [ids[0], ids[0]], true));
  } finally { h.connection.close(); }
});

test('connected settings retain invalid drafts and failed saves after virtual rows unmount and retry without losing newer metadata', async () => {
  const h = createDatabase(); let fail = true;
  try {
    await repository.initializeLocalDatabase(h.database); const snapshot = await repository.loadPlannerSnapshot(h.database, today); const chore = snapshot.chores.find(row => !row.archived);
    const document = createChoreSettingsDocument(h.database);
    const save = async (patch, base) => { if (fail) throw new Error('一時的な失敗'); await repository.updateChoreSettings(h.database, chore.id, patch, base); };
    const editor = document.get(chore, 'balanced', save); const unsubscribe = editor.subscribe(() => {});
    editor.changeCycle('17'); editor.changeRadius('999'); unsubscribe();
    assert.equal(await editor.flush(), false);
    const reopened = document.get(chore, 'balanced', save);
    assert.equal(reopened, editor); assert.equal(reopened.getSnapshot().draft.radiusText, '999'); assert.equal(reopened.getSnapshot().draft.cycleText, '17');
    await repository.updateChoreDefinition(h.database, { ...chore, name: '更新された家事名' });
    fail = false; assert.equal(await reopened.flush(), true);
    const stored = (await repository.loadPlannerSnapshot(h.database, today)).chores.find(row => row.id === chore.id);
    assert.equal(stored.name, '更新された家事名'); assert.equal(stored.recommendedCycleDays, 17); assert.equal(stored.windowRadiusDays, chore.windowRadiusDays);
    assert.notEqual(createChoreSettingsDocument({}).get(chore, 'balanced', save), editor);
  } finally { h.connection.close(); }
});

test('individual chore switches reject double taps roll back failed writes and retain saved values across a failed reread', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database); const rows = (await repository.loadPlannerSnapshot(h.database, today)).chores.filter(row => !row.archived).slice(0, 2).map(row => ({ ...row, enabled: false, category: '検査' }));
    const held = deferred(); let writes = 0; let phase = 'reject'; let expanded = new Set(['検査']);
    const props = { chores: rows, expanded, setExpanded: fn => { expanded = fn(expanded); props.expanded = expanded; }, onOpen: () => {}, retryRead: async () => { props.chores = rows.map(row => ({ ...row, enabled: true })); return true; },
      save: async () => { writes++; if (phase === 'reject') { await held.promise; throw new Error('保存失敗'); } return { refreshed: false }; } };
    const screen = screenHarness('src/features/settings/chore-toggle-list.tsx', { exportName: 'ChoreToggleList', props });
    await screen.press('検査の見出しを折りたたむ'); await screen.flush(); assert.equal(expanded.has('検査'), false);
    await screen.press('検査の見出しを展開'); await screen.flush(); assert.equal(expanded.has('検査'), true);
    const toggle = () => screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === `${rows[0].name}を有効にする`);
    toggle().props.onValueChange(true); toggle().props.onValueChange(true); await screen.flush(); assert.equal(writes, 1); assert.equal(toggle().props.value, true);
    held.resolve(); await screen.flush(); assert.equal(toggle().props.value, false); assert.ok(screen.text().includes('保存失敗'));
    phase = 'readFailure'; toggle().props.onValueChange(true); await screen.flush(); assert.equal(toggle().props.value, true); assert.equal(toggle().props.disabled, true); assert.match(screen.text(), /保存済み/u);
    await screen.press('家事の設定を再読込'); await screen.flush(); assert.equal(writes, 2); assert.equal(toggle().props.value, true); assert.equal(toggle().props.disabled, false);
  } finally { h.connection.close(); }
});

test('hardware back preserves invalid connected settings until corrected and then flushes before repeating navigation', async () => {
  const h = createDatabase(); let beforeRemove; let navigated = 0; let disabled = 0;
  try {
    await repository.initializeLocalDatabase(h.database); let snapshot = await repository.loadPlannerSnapshot(h.database, today); const chore = snapshot.chores[0];
    const screen = screenHarness('src/app/chores/[id].tsx', { database: h.database, snapshot: () => snapshot, params: { id: chore.id },
      refresh: async () => { snapshot = await repository.loadPlannerSnapshot(h.database, today); },
      preventRemove: (prevent, callback) => { if (prevent) beforeRemove = callback; }, disablePrevention: () => { disabled++; } });
    await screen.change('実施期間の日数幅', '999');
    beforeRemove({ repeat: () => { navigated++; } }); await screen.flush();
    assert.equal(navigated, 0); assert.equal(disabled, 0); assert.ok(screen.text().includes('数値に入力の誤り'));
    await screen.change('実施期間の日数幅', '2');
    beforeRemove({ repeat: () => { navigated++; } }); await screen.flush();
    assert.equal(navigated, 1); assert.equal(disabled, 1); assert.equal(snapshot.chores.find(row => row.id === chore.id).windowRadiusDays, 2);
  } finally { h.connection.close(); }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} connected chore book virtualizes long chapters keeps its fixed back header outside the list and jumps by stable identity`, async () => {
    const h = createDatabase();
    try {
      await repository.initializeLocalDatabase(h.database); const seed = (await repository.loadPlannerSnapshot(h.database, today)).chores[0];
      const chores = Array.from({ length: 1000 }, (_, i) => ({ ...seed, id: `item-${i}`, category: `分類${Math.floor(i / 200)}` }));
      const effects = []; const calls = []; let backs = 0;
      const screen = screenHarness('src/components/chore-book.tsx', { exportName: 'ChoreBook', platform, effect: callback => effects.push(callback),
        props: { chores, selectedId: 'item-850', title: '家事の説明', onBack: () => { backs++; }, renderChore: chore => chore.id } });
      const list = screen.nodes().find(node => node.type === 'FlatList'); assert.equal(list.props.data.length, 1000);
      for (const setting of ['initialNumToRender', 'maxToRenderPerBatch', 'windowSize']) {
        if (list.props[setting] !== undefined) assert.ok(list.props[setting] > 0 && list.props[setting] < chores.length,
          `${setting}: the native virtual list must not eagerly render the entire document`);
      }
      list.props.ref.current = { scrollToIndex: args => calls.push(['index', args.index]), scrollToOffset: args => calls.push(['offset', args.offset]) };
      const cleanup = effects.splice(0).map(callback => callback()).filter(Boolean); await delay(5);
      assert.deepEqual(calls.at(-1), ['index', 850]);
      list.props.onScrollToIndexFailed({ averageItemLength: 500, index: 850 }); assert.deepEqual(calls.at(-1), ['offset', 425000]);
      await delay(135); assert.deepEqual(calls.at(-1), ['index', 850]);
      await screen.press('分類1の先頭へ移動'); assert.deepEqual(calls.at(-1), ['index', 200]);
      await screen.press('前の画面に戻る'); assert.equal(backs, 1);
      assert.equal(list.children.some(node => node.props?.accessibilityLabel === '前の画面に戻る'), false);
      cleanup.forEach(fn => fn());
    } finally { h.connection.close(); }
  });

  test(`${platform} empty home omits its progress count percentage and bar while preserving the greeting`, async () => {
    const h = createDatabase();
    try {
      await repository.initializeLocalDatabase(h.database);
      await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [], previousDates: {}, weatherLocation: null });
      const stored = await repository.loadPlannerSnapshot(h.database, today);
      // The household timezone is an input; the runner's UTC/Tokyo timezone is not the fixture's region.
      for (const [timeZone, instant] of Object.entries({ 'Asia/Tokyo': '2026-10-29T10:00:00Z', UTC: '2026-10-29T19:00:00Z', 'America/Los_Angeles': '2026-10-30T02:00:00Z' })) {
        const snapshot = { ...stored, timeZone };
        const screen = screenHarness('src/app/(tabs)/index.tsx', { platform, database: h.database, snapshot: () => snapshot,
          mocks: { '@/hooks/use-home-clock': { useHomeClock: () => new Date(instant) } } });
        assert.ok(screen.text().includes('今日も1日お疲れ様でした'), timeZone);
        assert.equal(screen.text().includes('0件中'), false); assert.equal(screen.text().includes('0%'), false);
      }
    } finally { h.connection.close(); }
  });
}
