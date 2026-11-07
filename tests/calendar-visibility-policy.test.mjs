import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView } from './helpers/calendar-ui.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { calendarChoreDisplayThrough } from '../src/features/calendar/chore-display-range.ts';

const contains = (node, text) => typeof node === 'string' ? node.includes(text) : Boolean(node && (node.children ?? []).some(child => contains(child, text)));
const today = '2026-11-07';
test('calendar housework stops at the end of the second following month across year and leap boundaries', () => {
  assert.equal(calendarChoreDisplayThrough('2026-11-07'), '2027-01-31');
  assert.equal(calendarChoreDisplayThrough('2027-12-31'), '2028-02-29');
  assert.equal(calendarChoreDisplayThrough('2026-12-31'), '2027-02-28');
});
test('the final housework month accepts its clipped range without planning spillover days from the next month', async () => {
  const { fixture, seeds, now } = await import('./helpers/sharing-v2-repository-fixture.mjs');
  const { createV2GroupController } = await import('../src/features/sharing/v2/controller.ts');
  const { createV2ScreenSession } = await import('../src/features/sharing/v2-ui/screen-session.ts');
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds());
    const controller = createV2GroupController(d.repository, { now, makeId: () => 'unused', sync: async () => {} });
    const session = createV2ScreenSession({ controller, groupId: d.options.groupId, userId: 'owner', now,
      readPreferences: async () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
    const value = await session.readModel({ calendarMonth: '2026-12-01', calendarRange: { from: '2026-11-01', through: '2026-12-31' } });
    assert.equal(value.plan.range.through, '2026-12-31');
    await assert.rejects(session.readModel({ calendarMonth: '2027-11-01' }), /予定のみ/);
  } finally { d.connection.close(); }
});
for (const platform of ['ios', 'android']) {
  test(`${platform} shared calendar navigation never reloads the housework plan for a distant appointment date`, async () => {
    const { fixture, seeds, now } = await import('./helpers/sharing-v2-repository-fixture.mjs');
    const { createV2GroupController } = await import('../src/features/sharing/v2/controller.ts');
    const { createV2ScreenSession } = await import('../src/features/sharing/v2-ui/screen-session.ts');
    const f = await fixture(); const d = await f.device(); let screen; let leave;
    try {
      await d.repository.commit(seeds());
      const controller = createV2GroupController(d.repository, { now, makeId: () => 'unused', sync: async () => {} });
      const source = createV2ScreenSession({ controller, groupId: d.options.groupId, userId: 'owner', now,
        readPreferences: async () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) });
      const model = await source.readModel(); const reads = []; let focus;
      const session = { ...source, readModel: async options => { reads.push(options); return model; } };
      screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
        effectDependencies: true, effect: callback => callback(), layoutEffect: callback => callback(), focusEffect: callback => { focus = callback; },
        props: { purpose: 'workspace', view: 'calendar', lifecycleManaged: true, initialDisplay: { session, model }, loadSession: async () => session,
          onBack: () => {}, onConfiguration: () => {}, onHistory: () => {} } });
      leave = focus(); await screen.flush(); const initial = reads.length;
      await screen.press('表示する年と月を選択'); await screen.press('2027年'); await screen.press('11月'); await screen.press('2027年11月へ移動');
      await selectCalendarView(screen, '1日表示'); await screen.flush();
      assert.equal(reads.length, initial, 'choosing a far date must not trigger a shared/private Scheduler refresh');
      assert.doesNotMatch(screen.text(), /家事は未取得|共有予定を読み込んで|家事.*読込/);
    } finally { leave?.(); screen?.unmount(); d.connection.close(); }
  });
  test(`${platform} distant calendars display saved appointments without calculating or requesting housework outside the two-month horizon`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); const requested = [];
    const far = { ...newEventDraft('2027-11-07', 'Asia/Tokyo'), id: 'future-saved', revision: 1, title: '保存済みの来年の予定' };
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform,
      effectDependencies: true, effect: work => work(), props: {
        today, timeZone: 'Asia/Tokyo', onMonth: day => requested.push(day), monthLoaded: () => false,
        dayInfo: day => { assert.ok(day <= '2027-01-31', `unnecessary housework calculation: ${day}`); return { loaded: true, total: 3, pending: 3 }; }, renderChores: () => null,
        local: { database: {}, snapshot: { events: [far], exceptions: [], categories: [], draft: null, drafts: [] }, loading: false, error: null, refresh: async () => {} },
      } });
    await screen.press('表示する年と月を選択'); await screen.press('2027年'); await screen.press('11月'); await screen.press('2027年11月へ移動');
    t.mock.timers.tick(300); await screen.flush();
    assert.deepEqual(requested, []); assert.ok(screen.text().includes(far.title));
    const day = screen.nodes().find(node => node.props.accessibilityLabel?.startsWith('2027年11月7日、'));
    assert.ok(day); assert.doesNotMatch(day.props.accessibilityLabel, /家事|読込|未取得/);
    screen.unmount(); t.mock.timers.reset();
  });
  test(`${platform} expanded housework stays in its own scrolling pane when the calendar timeline scrolls`, async () => {
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 2, pending: 2 }), renderChores: day => `固定する家事:${day}`,
    } });
    for (const mode of ['1日表示', '2日表示']) {
      await selectCalendarView(screen, mode);
      const label = '2026年11月7日の家事を開く';
      if (screen.nodes().some(node => node.props.accessibilityLabel === label)) await screen.press(label);
      const timeline = screen.nodes().find(node => node.props.testID === 'calendar-timeline');
      const pane = screen.nodes().find(node => node.props.testID === 'calendar-fixed-chores');
      assert.ok(pane); assert.ok(contains(pane, `固定する家事:${today}`));
      assert.equal(contains(timeline, `固定する家事:${today}`), false);
      timeline.props.onScroll?.({ nativeEvent: { contentOffset: { x: 0, y: 800 } } }); screen.render();
      assert.ok(contains(screen.nodes().find(node => node.props.testID === 'calendar-fixed-chores'), `固定する家事:${today}`));
    }
    screen.unmount();
  });
  test(`${platform} official holidays annotate the date without an all-day appointment card`, async () => {
    const holiday = { ...newEventDraft(today, 'Asia/Tokyo'), id: 'holiday', revision: 1, title: '祝日の検査', allDay: true, holiday: true, blocksTime: false, readOnly: true };
    const trip = { ...holiday, id: 'trip', title: '旅行', holiday: undefined, blocksTime: true, readOnly: false };
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0, pending: 0 }), renderChores: () => null,
      local: { database: {}, snapshot: { events: [holiday, trip], exceptions: [], categories: [], draft: null, drafts: [] }, loading: false, error: null, refresh: async () => {} },
    } });
    for (const mode of ['1日表示', '2日表示', 'リスト表示']) {
      await selectCalendarView(screen, mode); assert.ok(screen.text().includes(holiday.title));
      assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === `${holiday.title}を編集`), false);
      screen.button('旅行を編集');
    }
    screen.unmount();
  });
  test(`${platform} start and end time pickers offer five-minute steps without rewriting an existing imported minute on open`, async () => {
    for (const label of ['開始', '終了']) {
      let native; const accepted = [];
      const field = screenHarness('src/features/calendar/calendar-field.tsx', { exportName: 'CalendarField', platform, datePicker: value => { native = value; }, props: {
        label, date: today, minute: 634, mode: 'time', onMinute: value => accepted.push(value),
      } });
      await field.press(`${label}を選択`);
      const picker = platform === 'android' ? native : field.nodes().find(node => node.type === 'DateTimePicker').props;
      assert.equal(picker.minuteInterval, 5); assert.equal(picker.display, 'spinner');
      assert.equal(picker.value.getUTCMinutes(), 34); assert.deepEqual(accepted, []);
      picker.onValueChange({}, new Date(Date.UTC(2026, 10, 7, 10, 40))); assert.deepEqual(accepted, [640]);
      field.unmount();
    }
  });
}
