import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { personalLongCalendarPreviews } from '../src/features/calendar/long-cycle-preview.ts';
import { japaneseHolidayLabel, japaneseHolidayLabels } from '../src/features/calendar/holiday-label.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { openCalendarDay, selectCalendarView } from './helpers/calendar-ui.mjs';

const day = '2026-11-07';
const chore = (id, days) => ({ id, householdId: 'local-household', name: id, enabled: true, estimatedMinutes: 10, load: 'normal',
  frequencyDaysByMode: { frequent: days, balanced: days, relaxed: days }, windowRadiusDays: 2, instructions: [], tools: [], cautions: [] });
const entry = (id, choreId, date, end = date) => ({ id, choreId, householdId: 'local-household', cycleBaseDate: date, suggestedDate: date,
  windowStart: date, windowEnd: end, status: 'scheduled', assignedMemberIds: [] });
const snapshot = (chores, scheduleEntries) => ({ chores, scheduleEntries, completions: [], settings: { frequencyMode: 'balanced' } });

test('long calendar previews keep only the next real round and omit periods below ninety days', () => {
  const input = snapshot([chore('short', 89), chore('quarter', 90), chore('annual', 365)], [
    entry('short1', 'short', '2027-02-01'), entry('q2', 'quarter', '2027-05-02'), entry('q1', 'quarter', '2027-02-01'), entry('q3', 'quarter', '2027-07-31'), entry('a1', 'annual', '2027-11-01'),
  ]);
  const result = personalLongCalendarPreviews(input, day);
  assert.deepEqual(result.map(row => [row.chore.id, row.entry.id, row.provisional]), [['quarter', 'q1', false], ['annual', 'a1', false]]);
});
test('an expired uncompleted long round shows one tentative next cycle without changing its original pending round or history', () => {
  const input = snapshot([chore('annual', 365)], [entry('pending', 'annual', '2026-11-01', '2026-11-03')]);
  const before = structuredClone(input); const result = personalLongCalendarPreviews(input, day);
  assert.equal(result.length, 1); assert.equal(result[0].entry.suggestedDate, '2027-11-01'); assert.equal(result[0].provisional, true);
  assert.notEqual(result[0].entry.id, input.scheduleEntries[0].id); assert.deepEqual(input, before);
  assert.deepEqual(personalLongCalendarPreviews(snapshot([chore('unknown', 365)], []), day), [], 'no guessed date for an unconfigured chore');
});
test('long preview expiry preserves an adopted month-end phase and never overwrites the learned model', () => {
  const input = snapshot([chore('quarter', 90)], [entry('pending', 'quarter', '2026-07-31', '2026-08-02')]);
  input.personalCadences = { quarter: { days: 92, automatic: true, windowRadiusDays: 2, calendarModel: { method: 'monthEnd', months: 3, anchor: '2026-07-31' } } };
  const before = structuredClone(input);
  const result = personalLongCalendarPreviews(input, day); assert.equal(result.length, 1); assert.equal(result[0].entry.suggestedDate, '2027-01-31'); assert.deepEqual(input, before);
});
test('a long round remains the current next round through its final day and advances only after expiry', () => {
  const input = snapshot([chore('annual', 365)], [entry('pending', 'annual', '2026-11-01', '2026-11-07')]);
  assert.equal(personalLongCalendarPreviews(input, day)[0].entry.id, 'pending');
  const after = personalLongCalendarPreviews(input, '2026-11-08');
  assert.equal(after.length, 1); assert.equal(after[0].provisional, true); assert.equal(after[0].entry.suggestedDate, '2027-11-01');
  assert.equal(input.completions.length, 0); assert.equal(input.scheduleEntries[0].id, 'pending');
});
test('long preview does not guess a missing learned cadence and survives unsupported future calendar bounds', () => {
  const input = snapshot([chore('unknown', 365)], [entry('unknown1', 'unknown', '2026-11-01')]);
  input.personalCadences = { unknown: { days: null, automatic: true, windowRadiusDays: 2 } };
  assert.deepEqual(personalLongCalendarPreviews(input, day), []);
  assert.deepEqual(personalLongCalendarPreviews(snapshot([chore('last', 365)], [entry('last1', 'last', '9999-11-01')]), '9999-12-01'), []);
});
test('calendar-only tentative private rounds neither add home load nor become writable commands', async () => {
  const { projectV2PrivateTasks, createV2PrivateTaskSource } = await import('../src/features/sharing/v2-ui/private-overlay.ts');
  const input = { ...snapshot([chore('annual', 365)], [entry('expired', 'annual', '2026-11-01', '2026-11-03')]),
    household: { id: 'local-household' }, settings: { frequencyMode: 'balanced', setupCompleted: true } };
  const captured = { ownerUserId: 'owner', today: day, timeZone: 'Asia/Tokyo', snapshot: input };
  const range = { from: '2026-11-01', through: '2026-11-30' };
  const before = structuredClone(input); const overlay = projectV2PrivateTasks(captured, 'owner', range);
  assert.equal(overlay.calendarLongRows.length, 1); assert.equal(overlay.calendarLongRows[0].provisional, true);
  assert.equal(overlay.calendarLongRows[0].date, '2027-11-01'); assert.equal(overlay.byDate.has('2027-11-01'), false);
  assert.equal(overlay.home.some(row => row.date === '2027-11-01'), false); assert.equal(overlay.dailyLoad['2027-11-01'], undefined);
  let saved = 0;
  const source = createV2PrivateTaskSource({ ownerUserId: 'owner', assertAccess() {}, readSnapshot: async () => captured, save: async () => { saved++; return true; } });
  const view = await source.read(range, new Date()); const preview = view.calendarLongRows[0];
  await assert.rejects(source.setCompleted(preview.key, preview.revision, true), /選び直し/); assert.equal(saved, 0);
  assert.deepEqual(input, before);
});
test('Japanese holiday labels retain source titles while translating known names and safely labeling unsupported and prototype-like names', () => {
  assert.equal(japaneseHolidayLabel('Election Day'), '選挙の日'); assert.equal(japaneseHolidayLabel('Culture Day'), '文化の日');
  assert.equal(japaneseHolidayLabel('文化の日'), '文化の日'); assert.equal(japaneseHolidayLabel("New Year’s Day (observed)"), '元日（振替休日）');
  for (const value of ['constructor', '__proto__', 'an unknown holiday', 'Fête inconnue']) assert.equal(japaneseHolidayLabel(value), '祝日');
  const rows = [{ holiday: true, title: 'Culture Day' }, { holiday: true, title: '文化の日' }, { holiday: true, title: 'Election Day' }];
  const before = structuredClone(rows); assert.deepEqual(japaneseHolidayLabels(rows), ['文化の日', '選挙の日']); assert.deepEqual(rows, before);
});
test('shared long-round reads query the next real frame and missed deadlines never fabricate completion facts', async () => {
  const { fixture, seeds, now, groupId } = await import('./helpers/sharing-v2-repository-fixture.mjs');
  const { createV2GroupController } = await import('../src/features/sharing/v2/controller.ts');
  const { listSharingOutbox } = await import('../src/platform/storage/sharing-ledger.ts');
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[3].payload.configuration = { ...initial[3].payload.configuration, anchorDate: '2026-01-01', intervalDays: 365 };
    await d.repository.commit(initial); let writes = 0;
    const controller = createV2GroupController(d.repository, { now, makeId: () => `calendar-long-${++writes}`, sync: async () => {} });
    const range = { from: '2026-10-01', through: '2026-12-31', asOfDate: '2026-10-27' };
    const before = await listSharingOutbox(d.database, groupId);
    const first = await controller.readModel(range, { calendarLong: true });
    assert.equal(first.calendarLong.length, 1); assert.equal(first.calendarLong[0].anchorDate, '2027-01-01'); assert.equal(first.plan.history.length, 0);
    assert.deepEqual(await listSharingOutbox(d.database, groupId), before); assert.equal(writes, 0);
    first.calendarLong[0].subjects.length = 0;
    assert.ok((await controller.readModel(range, { calendarLong: true })).calendarLong[0].subjects.length, 'the preview cache is isolated from an editable caller');
    const operations = await controller.actions.complete({ choreId: 'floor', anchorDate: '2027-01-01', ruleVersion: 1, subjectUserId: null });
    const completed = await controller.readModel(range, { calendarLong: true }); assert.equal(completed.calendarLong[0].anchorDate, '2028-01-01');
    await controller.actions.undoMany(operations.filter(row => row.entityType === 'completion').map(row => row.operationId));
    assert.equal((await controller.readModel(range, { calendarLong: true })).calendarLong[0].anchorDate, '2027-01-01');
  } finally { d.connection.close(); }
});
test('a moved long round stays visible after its original configuration ends and preview reads never re-enable a disabled later policy', async () => {
  const { fixture, seeds, now, draft } = await import('./helpers/sharing-v2-repository-fixture.mjs');
  const { createV2GroupController } = await import('../src/features/sharing/v2/controller.ts');
  const f = await fixture(); const d = await f.device(); let id = 0;
  try {
    const initial = seeds(); Object.assign(initial[3].payload.configuration, { anchorDate: '2026-01-01', intervalDays: 90 }); await d.repository.commit(initial);
    const controller = createV2GroupController(d.repository, { now, makeId: () => `long-rule-${++id}`, sync: async () => {} });
    await controller.actions.changeDate({ choreId: 'floor', anchorDate: '2026-01-01', ruleVersion: 1, subjectUserId: null }, { mode: 'day', target: { precision: 'date', date: '2026-12-15' } });
    await d.repository.commit([draft('disabled-new-policy', 'chorePolicy', 'floor', { configuration: { ...initial[3].payload.configuration, anchorDate: '2026-05-01',
      effectiveFrom: '2026-05-01', ruleVersion: 2, active: false } })]);
    const model = await controller.readModel({ from: '2026-10-01', through: '2026-11-30', asOfDate: '2026-10-27' }, { calendarLong: true });
    assert.equal(model.calendarLong.length, 1); assert.equal(model.calendarLong[0].anchorDate, '2026-01-01');
    assert.equal(model.calendarLong[0].subjects[0].suggestedDate, '2026-12-15'); assert.equal(model.calendarLong[0].ruleVersion, 1);
    assert.equal(model.plan.history.length, 0);
  } finally { d.connection.close(); }
});
for (const platform of ['ios', 'android']) {
  test(`${platform} personal calendars show only the next long round and preserve the unfinished original after expiry`, async () => {
    const input = { ...snapshot([chore('annual', 365), chore('short', 7)], [entry('old', 'annual', '2026-11-01', '2026-11-03'), entry('short-far', 'short', '2027-11-01')]),
      today: day, household: { id: 'local-household' }, hiddenWasteOccurrenceKeys: [], wasteSchedules: [], members: [], timeZone: 'Asia/Tokyo' };
    const screen = screenHarness('src/app/(tabs)/explore.tsx', { platform, snapshot: () => input, mocks: {
      '@/hooks/use-task-completion': { useTaskCompletion: () => ({ pending: new Set(), project: rows => rows, canToggle: () => false }) },
      '@/features/calendar/use-local-calendar': { useLocalCalendar: () => undefined },
    } });
    try {
      await openCalendarDay(screen, '2027-11-01'); assert.match(screen.text(), /annual/); assert.match(screen.text(), /仮/);
      assert.equal(screen.nodes().filter(node => node.props.accessibilityRole === 'checkbox').length, 1); assert.doesNotMatch(screen.text(), /short/);
      await openCalendarDay(screen, '2028-10-31'); assert.equal(screen.nodes().filter(node => node.props.accessibilityRole === 'checkbox').length, 0);
      assert.equal(input.completions.length, 0); assert.equal(input.scheduleEntries.find(row => row.id === 'old').windowEnd, '2026-11-03');
    } finally { screen.unmount(); }
    const early = { ...input, today: '2026-11-01', chores: [chore('quarter', 90)], scheduleEntries: [entry('next', 'quarter', '2026-11-01'), entry('extra', 'quarter', '2027-01-30')] };
    const second = screenHarness('src/app/(tabs)/explore.tsx', { platform, snapshot: () => early, mocks: {
      '@/hooks/use-task-completion': { useTaskCompletion: () => ({ pending: new Set(), project: rows => rows, canToggle: () => false }) },
      '@/features/calendar/use-local-calendar': { useLocalCalendar: () => undefined },
    } });
    try { await openCalendarDay(second, '2027-01-30'); assert.equal(second.nodes().filter(node => node.props.accessibilityRole === 'checkbox').length, 0); }
    finally { second.unmount(); }
  });
  test(`${platform} shared and private next long rounds share one distant day without short chores or another future cycle`, async () => {
    const { fixture, seeds, now, draft } = await import('./helpers/sharing-v2-repository-fixture.mjs');
    const { createV2GroupController } = await import('../src/features/sharing/v2/controller.ts');
    const { projectV2PrivateTasks } = await import('../src/features/sharing/v2-ui/private-overlay.ts');
    const f = await fixture(); const d = await f.device(); let screen; const reads = [];
    try {
      const initial = seeds(); Object.assign(initial[3].payload.configuration, { anchorDate: '2026-01-01', intervalDays: 365 });
      initial.push(draft('short', 'chore', 'short', { name: '遠方の短周期', enabled: true }), draft('short-policy', 'chorePolicy', 'short', {
        configuration: { ...initial[3].payload.configuration, intervalDays: 7, anchorDate: '2027-01-01' } }));
      await d.repository.commit(initial);
      const controller = createV2GroupController(d.repository, { now, makeId: () => 'unused', sync: async () => {} });
      const model = await controller.readModel({ from: '2026-10-01', through: '2026-12-31', asOfDate: '2026-10-27' }, { calendarLong: true });
      const input = { ...snapshot([chore('個人の年次', 365)], [entry('next', '個人の年次', '2027-01-01'), entry('extra', '個人の年次', '2028-01-01')]),
        household: { id: 'local-household' }, settings: { frequencyMode: 'balanced', setupCompleted: true } };
      const privateOverlay = projectV2PrivateTasks({ ownerUserId: 'owner', today: '2026-10-27', timeZone: 'Asia/Tokyo', snapshot: input }, 'owner', model.plan.range);
      const original = structuredClone(model);
      screen = screenHarness('src/features/sharing/v2-ui/calendar.tsx', { exportName: 'V2Calendar', platform, props: { model, privateOverlay,
        selectedDate: '2026-10-27', month: '2026-10-01', busy: false, actions: controller.actions, run: async () => {}, onMonth: date => reads.push(date), onSelectDate() {}, onRound() {} } });
      await openCalendarDay(screen, '2027-01-01');
      assert.match(screen.text(), /個人の年次/); assert.match(screen.text(), /床を掃除する/); assert.doesNotMatch(screen.text(), /遠方の短周期|未取得|通常生成範囲外/);
      assert.equal(screen.nodes().filter(node => node.props.accessibilityRole === 'checkbox').length, 2);
      assert.deepEqual(model, original, 'calendar-only projection cannot mutate a signed common plan'); assert.deepEqual(reads, []);
      await openCalendarDay(screen, '2028-01-01'); assert.equal(screen.nodes().filter(node => node.props.accessibilityRole === 'checkbox').length, 0);
    } finally { screen?.unmount(); d.connection.close(); }
  });
  test(`${platform} the measured expanded chore content fits without a fixed viewport cutting off a short list`, async () => {
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today: day, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 4, pending: 4 }), renderChores: () => '四つの家事',
    } });
    await selectCalendarView(screen, '2日表示'); await screen.press('2026年11月7日の家事を開く');
    const list = screen.nodes().find(node => node.props.accessibilityLabel === '2026年11月7日の家事一覧'); assert.ok(list);
    list.props.onContentSizeChange(160, 250); await screen.flush();
    const pane = screen.nodes().find(node => node.props.testID === 'calendar-fixed-chores'); const style = Object.assign({}, ...pane.props.style.flat(Infinity).filter(Boolean));
    assert.ok(style.height >= 250, 'a short measured list must fit rather than clipping its third card');
    screen.unmount();
  });
  test(`${platform} holiday annotations use one Japanese line without changing an imported event`, async () => {
    const { newEventDraft } = await import('../src/features/calendar/events.ts');
    const events = ['Culture Day', 'Election Day'].map((title, i) => ({ ...newEventDraft(day, 'Asia/Tokyo'), id: `holiday-${i}`, title, revision: 1, allDay: true, holiday: true, blocksTime: false }));
    const before = structuredClone(events);
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
      today: day, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null,
      local: { database: {}, snapshot: { events, exceptions: [], categories: [], drafts: [], draft: null } },
    } });
    for (const mode of ['month', '2日表示', '1日表示', 'リスト表示']) {
      if (mode !== 'month') await selectCalendarView(screen, mode);
      const labels = screen.nodes().filter(node => node.props.accessibilityLabel?.startsWith('祝日：'));
      assert.equal(labels.length, 1, mode); assert.equal(labels[0].props.accessibilityLabel, '祝日：文化の日・選挙の日'); assert.equal(labels[0].props.numberOfLines, 1);
    }
    assert.deepEqual(events, before); screen.unmount();
  });
  test(`${platform} a tentative personal calendar row cannot enter a durable completion queue`, () => {
    let requested = 0;
    const screen = screenHarness('src/features/sharing/v2-ui/private-task-card.tsx', { exportName: 'V2PrivateTaskCard', platform, props: {
      row: { key: 'preview', revision: '', provisional: true, chore: chore('annual', 365), completed: false, date: '2027-11-01', suggestedDate: '2027-11-01' },
      compact: true, busy: false, run: async () => { throw new Error('must not save'); }, onOpen: () => {},
      feedback: { values: new Map(), supports: () => true, request: () => { requested++; } }, source: { setCompleted: () => { throw new Error('must not save'); } },
    } });
    const checkbox = screen.nodes().find(node => node.props.accessibilityRole === 'checkbox'); assert.equal(checkbox.props.disabled, true); assert.equal(checkbox.props.onPress, undefined); assert.equal(requested, 0);
    screen.unmount();
  });
}
