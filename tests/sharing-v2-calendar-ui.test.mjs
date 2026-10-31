import { openCalendarDay } from './helpers/calendar-ui.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { v2CalendarMonth, v2CalendarProjection } from '../src/features/sharing/v2-ui/calendar-projection.ts';
import { buildV2PersonalPlan } from '../src/features/sharing/v2/personal-plan.ts';
import { sharedLocalDate } from '../src/features/sharing/group-clock.ts';

async function setup(platform = 'ios', anchorDate = '2026-10-27', hideStatus = false) {
  const f = await fixture(); const d = await f.device(); let id = 0; const initial = seeds();
  if (hideStatus) initial[0].payload.configuration.showCompletionStatus = false;
  Object.assign(initial[3].payload.configuration, { anchorDate, intervalDays: 30 }); await d.repository.commit(initial);
  const controller = createV2GroupController(d.repository, { makeId: () => `calendar-ui-${++id}`, now, sync: async () => {} });
  const grid = v2CalendarMonth('2026-10-27'); const range = { from: grid.from, through: grid.through, asOfDate: '2026-10-27' };
  const navigation = []; const props = { model: await controller.readModel(range), month: grid.month, selectedDate: anchorDate, busy: false, actions: controller.actions,
    onRound: (...args) => navigation.push(args), onSelectDate: (date) => { props.selectedDate = date; }, onMonth: () => {},
    run: async (work) => { await work(); props.model = await controller.readModel(range); } };
  const screen = screenHarness('src/features/sharing/v2-ui/calendar.tsx', { exportName: 'V2Calendar', props, platform });
  await openCalendarDay(screen, anchorDate);
  return { ...f, d, controller, props, screen, navigation, close: () => d.connection.close() };
}

test('v2 calendar month cells use the minimum complete weeks and stay identical across device timezones', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      assert.equal(v2CalendarMonth('2026-02-15').cells.length, 28);
      assert.equal(v2CalendarMonth('2024-02-15').cells.length, 35);
      assert.ok(v2CalendarMonth('2024-02-15').cells.includes('2024-02-29'));
      const next = v2CalendarMonth('2026-12-28', 1); assert.equal(next.month, '2027-01-01'); assert.equal(next.cells.length, 42);
      assert.equal(v2CalendarMonth('2026-10-27').cells[0], '2026-09-27');
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('v2 calendar recommendation binding refuses another account, another group or an outdated common plan', async () => {
  const f = await setup();
  try {
    const model = f.props.model; const personal = buildV2PersonalPlan(model.plan, { viewerUserId: model.viewerUserId, now: now().getTime(),
      settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } });
    for (const patch of [{ viewerUserId: 'member' }, { groupId: 'other' }, { commonPlanHash: 'outdated' }]) {
      assert.throws(() => v2CalendarProjection(model, { ...personal, ...patch }), /本人と現在の共有予定/);
    }
    assert.ok(v2CalendarProjection(model, personal).byDate.size > 0);
  } finally { f.close(); }
});

test('v2 calendar never applies the viewers private recommendation to another assigned member', async () => {
  const f = await setup();
  try {
    await f.controller.actions.assign({ choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null }, ['member'], 'this', false);
    const model = await f.controller.readModel({ from: '2026-10-01', through: '2026-10-31', asOfDate: '2026-10-27' });
    const personal = buildV2PersonalPlan(model.plan, { viewerUserId: 'owner', now: now().getTime(),
      settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } });
    const candidate = personal.recommendations.find((entry) => entry.date === '2026-10-27'); assert.ok(candidate);
    candidate.date = '2026-10-28'; const before = JSON.stringify(model.plan);
    const projection = v2CalendarProjection(model, personal);
    assert.ok(projection.byDate.get('2026-10-27')?.some((entry) => entry.id === candidate.subjectOccurrenceId));
    const inPeriod = projection.byDate.get('2026-10-28')?.find(entry => entry.id === candidate.subjectOccurrenceId);
    assert.ok(inPeriod, 'calendar counts every day inside the execution period');
    assert.equal(inPeriod.recommendation, undefined); assert.equal(inPeriod.date, '2026-10-27');
    assert.equal(JSON.stringify(model.plan), before);
  } finally { f.close(); }
});

test('v2 model clock ranges use the timezone from the same authenticated read instead of a prior device-zone read', async () => {
  const f = await setup();
  try {
    await f.d.repository.commit([draft('clock-zone', 'settings', 'settings', { timeZone: 'America/New_York' })]);
    const model = await f.controller.readModel(({ timeZone }) => { const date = sharedLocalDate(now(), timeZone); return { from: date, through: date, asOfDate: date }; });
    assert.equal(model.plan.timeZone, 'America/New_York'); assert.equal(model.plan.range.asOfDate, '2026-10-26');
  } finally { f.close(); }
});

test('v2 calendar markers follow shared-card visibility and cannot reveal another assignees hidden completion state', async () => {
  const f = await setup('ios', '2026-10-27', true); const range = { from: '2026-10-01', through: '2026-10-31', asOfDate: '2026-10-27' };
  try {
    const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
    let model = await f.controller.readModel(range);
    assert.equal(v2CalendarProjection({ ...model, viewerUserId: 'member' }).counts.get(ref.anchorDate), 1, 'an unassigned common round is visible to all members');
    await f.controller.actions.assign(ref, ['owner'], 'this', false); model = await f.controller.readModel(range);
    assert.equal(v2CalendarProjection({ ...model, viewerUserId: 'member' }).counts.get(ref.anchorDate) ?? 0, 0);
    await f.controller.actions.complete(ref); model = await f.controller.readModel(range);
    assert.equal(model.plan.occurrences[0].completed, true);
    assert.equal(v2CalendarProjection({ ...model, viewerUserId: 'member' }).counts.get(ref.anchorDate) ?? 0, 0);
    assert.equal(v2CalendarProjection({ ...model, viewerUserId: 'member' }, undefined,
      new Map([[`shared:${model.plan.occurrences[0].subjects[0].id}`, false]])).counts.get(ref.anchorDate) ?? 0, 0);
  } finally { f.close(); }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 calendar reflects completion feedback immediately without changing stored state or shifting the loaded header`, async () => {
    const f = await setup(platform);
    try {
      const subject = f.props.model.plan.occurrences[0].subjects[0]; const key = `shared:${subject.id}`;
      const before = JSON.stringify(f.props.model);
      f.props.feedback = { values: new Map([[key, true]]), run: async () => {} }; f.props.busy = true; f.screen.render();
      assert.ok(f.screen.nodes().some(node => node.props.accessibilityLabel === '2026年10月27日、確認できる未完了の共有家事0件'));
      assert.equal(f.screen.nodes().find(node => node.props.accessibilityRole === 'checkbox').props.accessibilityState.checked, true);
      assert.equal(f.screen.text().includes('共有予定を読み込んでいます…'), false);
      assert.equal(JSON.stringify(f.props.model), before);
      f.props.feedback.values.clear(); f.screen.render();
      assert.ok(f.screen.nodes().some(node => node.props.accessibilityLabel === '2026年10月27日、確認できる未完了の共有家事1件'));
      await f.controller.actions.complete({ choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null });
      f.props.model = await f.controller.readModel({ from: '2026-09-27', through: '2026-10-31', asOfDate: '2026-10-27' });
      f.props.feedback.values.set(key, false); f.screen.render();
      assert.ok(f.screen.nodes().some(node => node.props.accessibilityLabel === '2026年10月27日、確認できる未完了の共有家事1件'));
      assert.equal(f.props.model.plan.occurrences[0].subjects[0].completed, true);
    } finally { f.close(); }
  });
  test(`${platform} calendar mutations keep the visible cards and known counts while disabling another action instead of emptying the list`, async () => {
    const f = await setup(platform);
    try {
      const list = f.screen.nodes().find((node) => node.props.testID === 'calendar-chore-list');
      assert.ok(list.props.itemLayoutAnimation, 'the virtualized cells must animate their reordered positions');
      const before = list.props.data.map((entry) => entry.key);
      assert.ok(before.length > 0); f.props.busy = true; f.screen.render();
      assert.deepEqual(f.screen.nodes().find((node) => node.props.testID === 'calendar-chore-list').props.data.map((entry) => entry.key), before);
      assert.ok(f.screen.nodes().some((node) => node.props.accessibilityLabel === '2026年10月27日、確認できる未完了の共有家事1件'));
      assert.equal(f.screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox').props.disabled, true);
      assert.equal(f.props.model.plan.history.length, 0);
    } finally { f.close(); }
  });
  test(`${platform} v2 calendar completion reduces the displayed count to zero while keeping the completed card on its day`, async () => {
    const f = await setup(platform);
    try {
      const day = f.screen.nodes().find((node) => node.props.accessibilityLabel === '2026年10月27日、確認できる未完了の共有家事1件'); assert.ok(day);
      const before = f.props.model.plan.sourceHash; const checkbox = f.screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox');
      await checkbox.props.onPress(); await f.screen.flush();
      assert.ok(f.screen.nodes().some((node) => node.props.accessibilityLabel === '2026年10月27日、確認できる未完了の共有家事0件'));
      assert.equal(f.screen.nodes().filter((node) => node.props.accessibilityRole === 'checkbox').length, 1);
      assert.equal(f.screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox').props.accessibilityState.checked, true);
      assert.notEqual(f.props.model.plan.sourceHash, before); assert.equal(f.props.model.plan.history.length, 1);
    } finally { f.close(); }
  });
  test(`${platform} v2 calendar retains rounds beyond the home expiry cutoff and opens their real group identity`, async () => {
    const f = await setup(platform, '2026-10-12');
    try {
      const round = f.props.model.plan.occurrences.find((entry) => entry.anchorDate === '2026-10-12'); assert.equal(round.subjects[0].showExpiredOnHome, false);
      await f.screen.press('床を掃除するの説明を開く'); assert.deepEqual(f.navigation, [[round.id, round.subjects[0].id, '2026-10-12']]);
      assert.equal(f.props.model.plan.history.length, 0);
    } finally { f.close(); }
  });
  test(`${platform} v2 unloaded calendar months show a retry state rather than falsely claiming an empty day`, async () => {
    const f = await setup(platform);
    try {
      await openCalendarDay(f.screen, '2027-03-01');
      assert.ok(f.screen.text().includes('この月の共有予定を取得できていません'));
      assert.equal(f.screen.text().includes('この日の共有家事はありません'), false);
      assert.ok(f.screen.nodes().some((node) => node.props.accessibilityLabel === '2027年3月1日、予定は未取得'));
      assert.equal(f.screen.button('この月を再読込').props.disabled, false);
    } finally { f.close(); }
  });
}
