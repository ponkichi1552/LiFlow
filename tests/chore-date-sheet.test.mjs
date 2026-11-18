import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { openCalendarDay } from './helpers/calendar-ui.mjs';
import { fixture, seeds, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { projectV2PrivateTasks } from '../src/features/sharing/v2-ui/private-overlay.ts';
const repo = await import('../src/platform/storage/repository.ts');
async function flush(ui) { for (let i = 0; i < 14; i++) await ui.flush(); }

for (const platform of ['ios', 'android']) {
  test(`${platform} shared calendar rows and timed chores open the captured occurrence date editor without changing home guides or writing`, async t => {
    const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
    let sequence = 0; const controller = createV2GroupController(d.repository, { makeId: () => `calendar-route-${++sequence}`, now, sync: async () => {} });
    const plain = await controller.actions.addConfiguredChore('日付だけの共有家事', 1, chorePolicyFromPreset('common'), { once: true, startDate: '2026-10-27' });
    const timed = await controller.actions.addConfiguredChore('時刻付きの共有家事', 1, chorePolicyFromPreset('common'), { once: true, startDate: '2026-10-27',
      calendarTiming: { allDay: false, startMinute: 600, endMinute: 615, endDayOffset: 0, timeZone: 'Asia/Tokyo' } });
    const range = { from: '2026-10-01', through: '2026-10-31', asOfDate: '2026-10-27' };
    const model = await controller.readModel(range); const writes = d.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n;
    const dates = []; const ui = screenHarness('src/features/sharing/v2-ui/calendar.tsx', { platform, exportName: 'V2Calendar', props: {
      model, month: range.from, selectedDate: range.asOfDate, busy: false, actions: controller.actions, run: async () => assert.fail('opening a date editor must not save'),
      onRound: () => assert.fail('calendar editing must not open a completion form'), onGuide: () => assert.fail('calendar editing must not open a guide'),
      onDate: (...args) => dates.push(args), onMonth() {}, onSelectDate() {},
    } }); t.after(() => ui.unmount());
    await openCalendarDay(ui, range.asOfDate);
    for (const [operations, name, action] of [[plain, '日付だけの共有家事', 'の今回の日付を変更'], [timed, '時刻付きの共有家事', 'を編集']]) {
      const choreId = operations.find(op => op.entityType === 'chore').entityId;
      const round = model.plan.occurrences.find(row => row.choreId === choreId); assert.ok(round);
      await ui.press(`${name}${action}`);
      assert.deepEqual(dates.at(-1), [round.id, round.subjects[0].id, range.asOfDate, round.anchorDate]);
      let guides = 0; const home = screenHarness('src/features/sharing/v2-ui/round-card.tsx', { platform, exportName: 'V2RoundCard', props: {
        model, round, subject: round.subjects[0], home: true, busy: false, actions: controller.actions, run: async work => work(),
        onOpen: () => { guides++; }, onDate: () => assert.fail('a Home row opens its guide'),
      } });
      try { await home.press(`${name}の説明を開く`); assert.equal(guides, 1); assert.equal(home.nodes().filter(node => node.props.accessibilityRole === 'checkbox').length, 1); }
      finally { home.unmount(); }
    }
    assert.equal(d.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n, writes);
    assert.equal((await controller.readModel(range)).plan.planHash, model.plan.planHash);
    assert.equal(ui.nodes().filter(node => node.props.accessibilityRole === 'checkbox').length, 0);
  });
  test(`${platform} chore date sheet closes without saving and saves only its captured occurrence after a date is picked`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-14T00:00:00Z') });
    const h = createDatabase(); t.after(() => h.connection.close()); await repo.initializeLocalDatabase(h.database);
    await repo.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [1,2,3,4,5,6,7], enabledChoreIds: [], previousDates: {}, weatherLocation: null });
    const chore = await repo.registerPersonalCalendarChore(h.database, { operationId: 'calendar-intent.sheet-create', name: '洗濯機の洗剤・柔軟剤投入口とゴムパッキンの汚れ落とし', date: '2026-11-15', repeat: true, intervalDays: 14 });
    const data = { database: h.database, snapshot: await repo.loadPlannerSnapshot(h.database), error: null,
      refresh: async () => { data.snapshot = await repo.loadPlannerSnapshot(h.database); } };
    const entry = data.snapshot.scheduleEntries.find(row => row.choreId === chore.id); assert.ok(entry);
    const before = await repo.readPersonalChoreDate(h.database, chore.id, entry.id); let closed = 0; let picker;
    const open = () => screenHarness('src/app/calendar-chore-date.tsx', { platform, effectDependencies: true, effect: fn => fn(), datePicker: value => { picker = value; }, mocks: {
      'expo-router': { router: { back: () => { closed++; } }, Stack: { Screen: 'StackScreen' }, useLocalSearchParams: () => ({ choreId: chore.id, entryId: entry.id }) },
      '../../hooks/use-planner-data': { usePlannerData: scope => { assert.equal(scope.personal, true); return data; } },
    } });
    const pick = async ui => {
      const date = new Date('2026-11-20T00:00:00Z');
      if (platform === 'ios') ui.nodes().find(row => row.type === 'DateTimePicker').props.onValueChange({}, date);
      else { await ui.press('今回の実施日を選択'); picker.onValueChange({}, date); }
      await flush(ui);
    };
    let ui = open();
    try {
      await flush(ui); assert.ok(ui.text().includes(chore.name), 'the date sheet must identify the complete chore name'); await pick(ui);
      assert.deepEqual(await repo.readPersonalChoreDate(h.database, chore.id, entry.id), before, 'selection alone must not save');
      await ui.press('家事の日付変更を閉じる'); assert.equal(closed, 1);
    } finally { ui.unmount(); }
    ui = open();
    try {
      await flush(ui);
      if (platform === 'ios') assert.equal(ui.nodes().find(row => row.type === 'DateTimePicker').props.value.toISOString().slice(0, 10), entry.suggestedDate);
      await pick(ui);
      const save = ui.nodes().find(row => row.props.accessibilityLabel === '今回の実施日を保存');
      save.props.onPress(); save.props.onPress(); await flush(ui);
      assert.equal(closed, 2, 'double taps save and close only once');
      const after = await repo.loadPlannerSnapshot(h.database);
      assert.equal(after.scheduleEntries.find(row => row.id === entry.id)?.suggestedDate, '2026-11-20');
      assert.equal((await repo.readPersonalChoreDate(h.database, chore.id, entry.id)).signature, before.signature);
      assert.equal(after.completions.length, 0);
    } finally { ui.unmount(); }
  });
  test(`${platform} calendar chore rows omit completion controls while home keeps independent guide and completion actions`, async () => {
    const name = 'エアコン室内機のフィルター・吹き出し口・ルーバーの掃除';
    for (const compact of [true, false]) for (const completed of [false, true]) {
      let opened = 0; let toggled = 0; let changed = 0;
      const ui = screenHarness('src/components/task-checkbox-row.tsx', { platform, exportName: 'TaskCheckboxRow', props: {
        chore: { name, id: 'bath', householdId: '', enabled: true }, home: !compact, compact, completed,
        onOpen: () => { opened++; }, onChangeDate: compact && !completed ? () => { changed++; } : undefined, onToggle: () => { toggled++; },
      } });
      try {
        const checks = ui.nodes().filter(row => row.props.accessibilityRole === 'checkbox');
        if (compact) {
          assert.equal(checks.length, 0, 'calendar rows must not expose complete or undo controls');
          const label = `${name}の${completed ? '説明を開く' : '今回の日付を変更'}`;
          const opener = ui.nodes().find(row => row.props.accessibilityLabel === label); assert.ok(opener);
          if (completed) assert.equal(opener.props.accessibilityValue?.text, '完了済み');
          await ui.press(label); assert.equal(toggled, 0); assert.equal(changed, completed ? 0 : 1); assert.equal(opened, completed ? 1 : 0);
        } else {
          assert.equal(checks.length, 1); assert.equal(checks[0].props.accessibilityState.checked, completed);
          await checks[0].props.onPress(); await ui.flush(); assert.equal(toggled, 1); assert.equal(opened, 0); assert.equal(changed, 0);
          await ui.press(`${name}の説明を開く`); assert.equal(opened, 1); assert.equal(toggled, 1); assert.equal(changed, 0);
        }
      } finally { ui.unmount(); }
    }
  });
  test(`${platform} shared home private chores open guides while calendar rows edit dates without adding a second action`, async () => {
    for (const compact of [false, true]) {
      let opened = 0; const navigation = [];
      const row = { key: 'personal:bath', date: '2026-11-14', suggestedDate: '2026-11-14', entryId: 'round',
        chore: { id: 'bath', name: '浴室の清掃', householdId: '', load: 'normal' }, completed: false };
      const ui = screenHarness('src/features/sharing/v2-ui/private-task-card.tsx', { platform, exportName: 'V2PrivateTaskCard', navigate: (...args) => navigation.push(args), props: {
        row, home: !compact, compact, busy: false, run: async work => work(), onOpen: () => { opened++; },
      } });
      try {
        if (compact) {
          assert.ok(!ui.nodes().some(node => node.props.accessibilityRole === 'checkbox'));
          assert.ok(!ui.nodes().some(node => node.props.accessibilityLabel === '浴室の清掃の説明を開く'));
          await ui.press('浴室の清掃の今回の日付を変更'); assert.equal(opened, 0);
          assert.deepEqual(navigation.at(-1)[1], { pathname: '/calendar-chore-date', params: { choreId: 'bath', entryId: 'round' } });
        } else {
          await ui.press('浴室の清掃の説明を開く'); assert.equal(opened, 1); assert.deepEqual(navigation, []);
          assert.ok(!ui.nodes().some(node => node.props.accessibilityLabel?.includes('今回の日付')));
        }
      } finally { ui.unmount(); }
    }
  });
  test(`${platform} timed personal chore blocks open their exact occurrence date sheet in personal and shared calendars without writing`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-14T00:00:00Z') });
    const h = createDatabase(); t.after(() => h.connection.close()); await repo.initializeLocalDatabase(h.database);
    await repo.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [1,2,3,4,5,6,7], enabledChoreIds: [], previousDates: {}, weatherLocation: null });
    const chore = await repo.registerPersonalCalendarChore(h.database, { operationId: 'calendar-intent.timed-navigation', name: '時刻付きの長い家事名の日付変更', date: '2026-11-14', repeat: true, intervalDays: 14,
      timing: { allDay: false, startMinute: 600, endMinute: 615, endDayOffset: 0, timeZone: 'Asia/Tokyo' } });
    const snapshot = await repo.loadPlannerSnapshot(h.database); const entry = snapshot.scheduleEntries.find(row => row.choreId === chore.id); assert.ok(entry?.calendarTime);
    const before = await repo.readPersonalChoreDate(h.database, chore.id, entry.id);
    const f = await fixture(); const device = await f.device(); t.after(() => device.connection.close()); await device.repository.commit(seeds());
    const controller = createV2GroupController(device.repository, { makeId: () => 'timed-path', now, sync: async () => {} });
    const range = { from: '2026-11-01', through: '2026-11-30', asOfDate: '2026-11-14' };
    const model = await controller.readModel(range);
    const overlay = projectV2PrivateTasks({ ownerUserId: model.viewerUserId, today: '2026-11-14', timeZone: 'Asia/Tokyo', snapshot }, model.viewerUserId, range);
    for (const shared of [false, true]) {
      const navigation = [];
      const options = { platform, database: h.database, snapshot: () => snapshot, navigate: (...args) => navigation.push(args), mocks: {
        '@/components/workspace-tab': { WorkspaceTab: props => props.children },
        '@/features/calendar/use-local-calendar': { useLocalCalendar: () => undefined },
      } };
      const ui = shared ? screenHarness('src/features/sharing/v2-ui/calendar.tsx', { ...options, exportName: 'V2Calendar', props: {
        model, month: '2026-11-01', selectedDate: '2026-11-14', privateOverlay: overlay, busy: false, actions: controller.actions,
        run: async work => work(), onRound: () => assert.fail('a personal chore must not open a shared round'), onGuide: () => assert.fail('a timed personal chore must not open the guide'), onMonth: () => {}, onSelectDate: () => {},
      } }) : screenHarness('src/app/(tabs)/explore.tsx', options);
      try {
        await openCalendarDay(ui, '2026-11-14');
        assert.ok(!ui.nodes().some(node => node.props.accessibilityRole === 'checkbox'), 'real personal and shared calendars omit completion controls');
        await ui.press(`${chore.name}を編集`);
        assert.deepEqual(navigation.at(-1)?.[1], { pathname: '/calendar-chore-date', params: { choreId: chore.id, entryId: entry.id } });
        assert.deepEqual(await repo.readPersonalChoreDate(h.database, chore.id, entry.id), before);
      } finally { ui.unmount(); }
    }
  });
}
