import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId, receiptsFor, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { loadSharedFacts, applyReceivedSharedFacts, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
const range = { from: '2026-10-20', through: '2026-11-10', asOfDate: '2026-10-27' };
let formInstance = 0;
const file = 'src/features/sharing/v2-ui/date-form.tsx';
const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
async function form(d, platform = 'ios', options = {}) {
  let id = 0; const instance = ++formInstance; const controller = createV2GroupController(d.repository, { makeId: () => `${d.options.userId}-date-form-${instance}-${++id}`, now: options.now ?? now, sync: async () => {} });
  const query = options.range ?? range;
  let running;
  const props = { actions: controller.actions, busy: false, ...options, run: (work) => {
    running = (async () => { await work(); await update(); })();
    return running;
  } };
  async function update() { const model = await controller.readModel(query); const round = model.plan.occurrences.find((r) => r.anchorDate === (options.anchorDate ?? ref.anchorDate));
    Object.assign(props, { model, round, subject: round.subjects[0] }); }
  await update(); const screen = screenHarness(file, { exportName: 'V2DateForm', props, platform, datePicker: options.datePicker });
  return { props, controller, screen, update, settleSave: () => {
    assert.ok(running, 'the date form must have started a save');
    return running;
  } };
}
async function pickShortcutDate(screen, platform, date) {
  screen.button('変更後の実施日を選択').props.onPress(); await screen.flush();
  if (platform === 'android') return;
  const picker = screen.nodes().find((node) => node.type === 'DateTimePicker'); assert.ok(picker, 'missing native date picker');
  picker.props.onValueChange(null, new Date(`${date}T12:00:00.000Z`)); await screen.flush();
  await screen.press('変更後の実施日の選択を完了');
}
async function choose(screen, label) {
  const node = screen.nodes().find((n) => n.props.accessibilityRole === 'radio' && n.props.accessibilityLabel === label);
  assert.ok(node, `missing choice ${label}`); assert.equal(node.props.disabled, false); node.props.onPress(); await screen.flush();
}
async function flag(screen, label, value) {
  const node = screen.nodes().find((n) => n.type === 'Switch' && n.props.accessibilityLabel === label); assert.ok(node); assert.equal(node.props.disabled, false); node.props.onValueChange(value); await screen.flush();
}
for (const platform of ['ios', 'android']) {
  test(`${platform} v2 members can explicitly request a locked date removal while the form retains the original formal schedule`, async () => {
    const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
    try {
      const initial = seeds(); initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['member']); await owner.repository.commit(initial);
      const source = await form(owner, platform); await source.controller.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' }, options: { strict: true, adminLocked: true } });
      const facts = await loadSharedFacts(owner.database, groupId);
      await applyReceivedSharedFacts(member.database, groupId, facts, '1', member.repository.project, null, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(facts)));
      const { screen, props } = await form(member, platform); await screen.press('適用中の日時指定を解除…'); await screen.press('選択した範囲の指定を解除する');
      assert.ok(screen.text().includes('解除申請を端末に保存')); assert.equal(props.model.requests[0].kind, 'pendingDelivery');
      assert.equal(props.subject.formalDate.target.date, '2026-10-28'); assert.ok(props.model.requests[0].proposal.cancellation);
    } finally { owner.connection.close(); member.connection.close(); }
  });
  test(`${platform} v2 date form saves only an explicit designation and defaults to one round without changing the common cadence`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds()); const { screen, props } = await form(d, platform);
      assert.equal(screen.nodes().find((n) => n.props.accessibilityLabel === '今回だけ').props.accessibilityState.checked, true);
      const before = (await listSharingOutbox(d.database, groupId)).length;
      await screen.change('実施日', '2026-02-30'); await screen.press('日時を指定・申請する'); assert.ok(screen.text().includes('日付は年-月-日'));
      await screen.change('実施日', '2026-10-28'); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
      await screen.press('日時を指定・申請する'); assert.ok(screen.text().includes('日時指定を端末に保存'));
      const rule = (await d.repository.readState()).assessment.view.ofType('designation')[0].payload.configuration;
      assert.equal(rule.selector.scope, 'once'); assert.equal(rule.selector.anchorDate, ref.anchorDate); assert.deepEqual(rule.target, { precision: 'date', date: '2026-10-28' });
      assert.equal(props.round.configuration.intervalDays, 7); assert.equal(props.model.plan.history.length, 0);
    } finally { d.connection.close(); }
  });
  test(`${platform} calendar date shortcut keeps a shared fixed chore start and end clock when its clicked date changes`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds());
      const controller = createV2GroupController(d.repository, { makeId: (() => { let id = 0; return () => `date-shortcut-${++id}`; })(), now, sync: async () => {} });
      await controller.actions.changeDate(ref, { mode: 'fixed', target: { precision: 'interval', start: '2026-10-27T01:15:00.000Z', end: '2026-10-27T01:45:00.000Z' } });
      const { screen, props, settleSave } = await form(d, platform, { initialDate: '2026-10-29', datePicker: ({ onValueChange }) => onValueChange(null, new Date('2026-10-29T12:00:00.000Z')) });
      assert.equal(screen.nodes().some((node) => node.type === 'TextInput' && ['開始時刻', '終了時刻'].includes(node.props.accessibilityLabel)), false);
      await screen.press('この日に変更'); await settleSave();
      assert.deepEqual(props.subject.formalDate.target, { precision: 'interval', start: '2026-10-29T01:15:00.000Z', end: '2026-10-29T01:45:00.000Z' });
      assert.equal(props.subject.formalDate.mode, 'fixed');
    } finally { d.connection.close(); }
  });
  test(`${platform} v2 fixed-date form requires explicit start and end plus repeated-clock choices without guessing a duration`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      const initial = seeds(); initial[1].payload.timeZone = 'America/New_York'; await d.repository.commit(initial);
      const { screen } = await form(d, platform); await choose(screen, '固定日時に実施'); await screen.change('実施日', '2026-11-01');
      await screen.change('開始時刻', '01:30'); await screen.change('終了日', '2026-11-01'); await screen.change('終了時刻', '01:45');
      const before = (await listSharingOutbox(d.database, groupId)).length;
      await screen.press('日時を指定・申請する'); assert.ok(screen.text().includes('どの時刻か')); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
      const groups = screen.nodes().filter((n) => n.props.accessibilityRole === 'radio' && n.props.accessibilityLabel === '2回目（UTC-05:00）'); assert.equal(groups.length, 2);
      groups[0].props.onPress(); groups[1].props.onPress(); await screen.flush(); await screen.press('日時を指定・申請する');
      const rule = (await d.repository.readState()).assessment.view.ofType('designation')[0].payload.configuration;
      assert.deepEqual(rule.target, { precision: 'interval', start: '2026-11-01T06:30:00.000Z', end: '2026-11-01T06:45:00.000Z' });
      assert.ok(screen.text().includes('端末に保存'));
    } finally { d.connection.close(); }
  });
}

for (const platform of ['ios', 'android']) {
  test(`${platform} shared date shortcut exposes both repeated-clock choices and restores the exact original fold when returning`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      const initial = seeds(); initial[1].payload.timeZone = 'America/New_York'; initial[1].payload.anchorDate = '2026-11-01'; initial[3].payload.configuration.anchorDate = '2026-11-01'; await d.repository.commit(initial);
      const reference = { ...ref, anchorDate: '2026-11-01' }; const target = { precision: 'interval', start: '2026-11-01T06:30:27.123Z', end: '2026-11-01T06:45:27.456Z' };
      const controller = createV2GroupController(d.repository, { makeId: () => 'date-shortcut-fold', now, sync: async () => {} });
      await controller.actions.changeDate(reference, { mode: 'fixed', target });
      let selectedDate = '2026-11-01';
      const { screen, props, settleSave } = await form(d, platform, { initialDate: '2026-11-02', anchorDate: reference.anchorDate,
        datePicker: ({ onValueChange }) => onValueChange(null, new Date(`${selectedDate}T12:00:00.000Z`)) });
      assert.equal(screen.nodes().some((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel.includes('回目')), false);
      selectedDate = '2026-11-01'; await pickShortcutDate(screen, platform, selectedDate);
      const choices = screen.nodes().filter((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '2回目（UTC-05:00）');
      assert.equal(choices.length, 2); assert.ok(choices.every((node) => node.props.accessibilityState.checked));
      assert.equal(screen.nodes().some((node) => node.type === 'TextInput' && ['開始時刻', '終了時刻'].includes(node.props.accessibilityLabel)), false);
      assert.equal(screen.nodes().some((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '日時指定の適用範囲'), false);
      await screen.press('この日に変更');
      await settleSave();
      assert.deepEqual(props.subject.formalDate.target, target);
    } finally { d.connection.close(); }
  });

  test(`${platform} shared date shortcut exposes only the missing DST clock and saves the corrected local time`, async () => {
    const clock = () => new Date('2027-03-10T12:00:00.000Z'); const f = await fixture({ clock }); const d = await f.device();
    try {
      const initial = seeds(); initial[1].payload.timeZone = 'America/New_York'; initial[1].payload.anchorDate = '2027-03-13'; initial[3].payload.configuration.anchorDate = '2027-03-13'; await d.repository.commit(initial);
      const reference = { ...ref, anchorDate: '2027-03-13' };
      const controller = createV2GroupController(d.repository, { makeId: () => 'date-shortcut-gap', now: clock, sync: async () => {} });
      await controller.actions.changeDate(reference, { mode: 'fixed', target: { precision: 'interval', start: '2027-03-13T07:30:00.000Z', end: '2027-03-13T08:15:00.000Z' } });
      const range = { from: '2027-03-01', through: '2027-03-20', asOfDate: '2027-03-10' };
      const { screen, props, settleSave } = await form(d, platform, { now: clock, range, anchorDate: reference.anchorDate, initialDate: '2027-03-14',
        datePicker: ({ onValueChange }) => onValueChange(null, new Date('2027-03-14T12:00:00.000Z')) });
      assert.ok(screen.text().includes('開始時刻がこの地域にはありません'));
      assert.ok(screen.nodes().some((node) => node.type === 'TextInput' && node.props.accessibilityLabel === '開始時刻'));
      assert.equal(screen.nodes().some((node) => node.type === 'TextInput' && node.props.accessibilityLabel === '終了時刻'), false);
      assert.equal(screen.text().includes('日時指定の適用範囲'), false);
      await screen.change('開始時刻', '01:30');
      assert.equal(screen.text().includes('開始時刻がこの地域にはありません'), false);
      await screen.press('この日に変更');
      await settleSave();
      assert.deepEqual(props.subject.formalDate.target, { precision: 'interval', start: '2027-03-14T06:30:00.000Z', end: '2027-03-14T07:15:00.000Z' });
    } finally { d.connection.close(); }
  });
}

test('v2 date form preserves the exact original second fold, seconds, milliseconds and lock options when only its application period changes', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[1].payload.timeZone = 'America/New_York'; initial[3].payload.configuration.anchorDate = '2026-11-01'; await d.repository.commit(initial);
    const reference = { ...ref, anchorDate: '2026-11-01' }; let id = 0;
    const controller = createV2GroupController(d.repository, { makeId: () => `exact-source-${++id}`, now, sync: async () => {} });
    const target = { precision: 'interval', start: '2026-11-01T06:30:27.123Z', end: '2026-11-01T06:45:27.456Z' };
    await controller.actions.changeDate(reference, { mode: 'fixed', target, options: { strict: true, adminLocked: true, forbidEarlier: true }, selector: { scope: 'ongoing', from: reference.anchorDate } });
    const { screen } = await form(d, 'ios', { anchorDate: reference.anchorDate }); await choose(screen, '2週間'); await screen.press('日時を指定・申請する');
    const rules = (await d.repository.readState()).assessment.view.ofType('designation'); assert.equal(rules.length, 2); assert.deepEqual(rules[1].payload.configuration.target, target);
    assert.deepEqual(rules[1].payload.configuration.selector, { scope: 'period', range: { from: '2026-11-01', through: '2026-11-14' } });
    for (const key of ['strict', 'adminLocked', 'forbidEarlier']) assert.equal(rules[1].payload.configuration[key], true);
  } finally { d.connection.close(); }
});

test('v2 date form keeps fixed-date member changes as unsent requests and never treats local saving as approval', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    const initial = seeds(); initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['member']); await owner.repository.commit(initial);
    const source = await form(owner); const fixed = { precision: 'interval', start: '2026-10-27T10:00:00.000Z', end: '2026-10-27T10:30:00.000Z' };
    await source.controller.actions.changeDate(ref, { mode: 'fixed', target: fixed });
    const facts = await loadSharedFacts(owner.database, groupId); await applyReceivedSharedFacts(member.database, groupId, facts, '5', member.repository.project, null, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(facts)));
    const { screen, props } = await form(member, 'android'); await screen.change('開始時刻', '20:00'); await screen.change('終了時刻', '20:30');
    assert.equal(screen.nodes().find((n) => n.props.accessibilityLabel === '管理者による固定').props.disabled, true);
    await screen.press('日時を指定・申請する'); assert.ok(screen.text().includes('受付と必要な承認の確認まで正式予定は変わりません'));
    assert.equal(props.model.requests[0].kind, 'pendingDelivery'); assert.deepEqual(props.subject.formalDate.target, fixed);
  } finally { owner.connection.close(); member.connection.close(); }
});

test('v2 date form refuses changed assignments and date sources and keeps an edited timezone draft without reinterpreting it', async () => {
  for (const change of ['assignment', 'date', 'zone']) {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds()); const { screen, controller, props, update } = await form(d);
      await screen.change('実施日', '2026-10-28');
      if (change === 'assignment') await controller.actions.assign(ref, ['member'], 'this', true);
      if (change === 'date') await controller.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-29' } });
      if (change === 'zone') await d.repository.commit([draft('updated-zone', 'settings', 'settings', { timeZone: 'America/New_York' })]);
      const before = (await listSharingOutbox(d.database, groupId)).length;
      await assert.rejects(screen.press('日時を指定・申請する'), { code: 'sharing/v2-stale-settings' }); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
      await update(); screen.render(); assert.equal(screen.button('日時を指定・申請する').props.disabled, true);
      if (change === 'zone') { assert.ok(screen.text().includes('日時の地域：Asia/Tokyo')); assert.ok(screen.text().includes('入力は保持'));
        assert.equal(screen.nodes().find((n) => n.props.accessibilityLabel === '実施日').props.value, '2026-10-28'); assert.equal(screen.button('日時を指定・申請する').props.disabled, true);
        props.model.plan.initialized = false; screen.render(); assert.equal(screen.nodes().some((n) => n.type === 'TextInput'), false); }
    } finally { d.connection.close(); }
  }
});

test('v2 date-form high-load confirmation applies only to unchanged input and cancellation cannot save the warning target', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit([...seeds(), draft('limit', 'settings', 'settings', { heavyDailyLimit: 1 }), draft('heavy', 'chore', 'floor', { load: 'heavy' }),
      draft('mop', 'chore', 'mop', { name: '水拭き', enabled: true, load: 'heavy' }), draft('mop-policy', 'chorePolicy', 'mop', { configuration: seeds()[3].payload.configuration })]);
    const { screen } = await form(d); const before = (await listSharingOutbox(d.database, groupId)).length;
    await screen.press('日時を指定・申請する'); assert.ok(screen.text().includes('家事の負荷が高く')); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    await screen.press('取り消す'); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    await screen.press('日時を指定・申請する'); await screen.change('実施日', '2026-10-28'); assert.equal(screen.text().includes('この日は家事の負荷が高く'), false);
    await screen.press('日時を指定・申請する'); assert.ok(screen.text().includes('端末に保存'));
  } finally { d.connection.close(); }
});

test('v2 date form checks only the viewers Calendar and requires conflict confirmation without publishing private intervals', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['owner']); await d.repository.commit(initial); let queries = 0;
    const { screen } = await form(d, 'ios', { readOwnCalendar: async () => { queries++; return { kind: 'conflict' }; } });
    await choose(screen, '固定日時に実施'); await screen.change('開始時刻', '19:00'); await screen.change('終了時刻', '19:30');
    const before = (await listSharingOutbox(d.database, groupId)).length;
    await screen.press('日時を指定・申請する'); assert.equal(queries, 1); assert.ok(screen.text().includes('カレンダーに予定が入っています')); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    await screen.press('指定する'); assert.equal(queries, 1); assert.ok(screen.text().includes('端末に保存'));
    const op = (await d.repository.readState()).assessment.view.ofType('designation')[0]; assert.equal(JSON.stringify(op).includes('calendar'), false);
  } finally { d.connection.close(); }
});

test('v2 missing-clock form explicitly reviews the source and saves a proposed-only request while preserving the absent formal time', async () => {
  const f = await fixture(); const d = await f.device(); const clock = () => new Date('2026-03-05T12:00:00Z');
  try {
    d.options.now = clock; const initial = seeds(); initial[1].payload.timeZone = 'America/New_York'; initial[1].payload.anchorDate = '2026-03-01'; initial[3].payload.configuration.anchorDate = '2026-03-01'; await d.repository.commit(initial);
    const controller = createV2GroupController(d.repository, { makeId: () => 'source-missing-clock', now: clock, sync: async () => {} });
    await controller.actions.changeDate({ ...ref, anchorDate: '2026-03-01' }, { mode: 'fixed', target: { precision: 'interval', start: '2026-03-01T07:30:00.000Z', end: '2026-03-01T07:45:00.000Z' }, selector: { scope: 'ongoing', from: '2026-03-01' } });
    const { screen, props } = await form(d, 'android', { now: clock, anchorDate: '2026-03-08', range: { from: '2026-03-01', through: '2026-03-15', asOfDate: '2026-03-05' } });
    assert.ok(screen.text().includes('変更先を基準に申請期限')); await screen.press('日時を指定・申請する'); assert.ok(screen.text().includes('元の指定と競合している内容を確認'));
    await flag(screen, '元の指定・競合内容を確認した', true); await screen.change('開始時刻', '03:30'); await screen.change('終了時刻', '03:45'); await screen.press('日時を指定・申請する');
    assert.equal(props.model.requests[0].proposal.original, null); assert.equal(props.model.requests[0].kind, 'pendingDelivery'); assert.equal(props.model.requests[0].formal, null);
  } finally { d.connection.close(); }
});

test('v2 date cancellation names the entire source period and preserves real history until explicit confirmation', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const first = await form(d); await first.controller.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' }, selector: { scope: 'ongoing', from: ref.anchorDate } });
    await first.controller.actions.complete(ref); const history = (await first.controller.readModel(range)).plan.history;
    const { screen, props } = await form(d); const before = (await listSharingOutbox(d.database, groupId)).length;
    await screen.press('適用中の日時指定を解除…'); assert.ok(screen.text().includes('2026-10-27から無期限')); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    await choose(screen, '元指定の全期間');
    await screen.press('表示した適用期間の指定を解除する'); assert.ok(screen.text().includes('実施履歴は保持')); assert.deepEqual(props.model.plan.history, history);
  } finally { d.connection.close(); }
});
for (const platform of ['ios', 'android']) {
  test(`${platform} v2 cancellation defaults to one round and changing its explicit range never edits the date draft or another subject`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      const initial = seeds(); initial[3].payload.configuration.intervalDays = 1; await d.repository.commit(initial);
      const source = await form(d, platform); const [rule] = await source.controller.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' }, selector: { scope: 'ongoing', from: ref.anchorDate } });
      const { screen, props } = await form(d, platform, { anchorDate: '2026-10-29' }); const before = (await listSharingOutbox(d.database, groupId)).length;
      await screen.press('適用中の日時指定を解除…'); assert.equal(screen.nodes().find((node) => node.props.accessibilityLabel === '今回だけ解除').props.accessibilityState.checked, true);
      await choose(screen, '解除の終了日を指定'); await screen.change('解除する最後の基準日', '2026-10-28');
      await screen.press('選択した範囲の指定を解除する'); assert.ok(screen.text().includes('適用期間の開始と終了')); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
      await screen.change('解除する最後の基準日', '2026-10-31'); await screen.press('選択した範囲の指定を解除する');
      const cancellation = (await d.repository.readState()).assessment.view.ofType('designationCancel')[0];
      assert.deepEqual(cancellation.payload, { targetOperationIds: [rule.operationId], selector: { scope: 'period', range: { from: '2026-10-29', through: '2026-10-31' } } });
      assert.equal(props.model.plan.occurrences.find((round) => round.anchorDate === '2026-10-28').subjects[0].formalDate.kind, 'manual');
      assert.equal(props.model.plan.occurrences.find((round) => round.anchorDate === '2026-11-01').subjects[0].formalDate.kind, 'manual');
      assert.ok(screen.text().includes('選択した範囲')); assert.equal(props.model.plan.history.length, 0);
    } finally { d.connection.close(); }
  });
}

test('v2 date form does not pretend a lower-priority repeating rule replaces the current one-off exception', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const source = await form(d); await source.controller.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' } });
    const { screen } = await form(d); await choose(screen, '2週間'); await screen.change('実施日', '2026-10-29');
    const before = (await listSharingOutbox(d.database, groupId)).length; await screen.press('日時を指定・申請する');
    assert.ok(screen.text().includes('この回の個別指定が優先')); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    await choose(screen, '今回だけ'); await screen.press('日時を指定・申請する'); assert.ok(screen.text().includes('端末に保存'));
  } finally { d.connection.close(); }
});

test('v2 date cancellation refuses an intervening source change instead of removing a different date from stale controls', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const source = await form(d); await source.controller.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' } });
    const { screen } = await form(d); await screen.press('適用中の日時指定を解除…');
    await choose(screen, '元指定の全期間');
    await source.controller.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-29' } }); const before = (await listSharingOutbox(d.database, groupId)).length;
    await assert.rejects(screen.press('表示した適用期間の指定を解除する'), { code: 'sharing/v2-stale-settings' }); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
  } finally { d.connection.close(); }
});

test('v2 assigning someone else never checks the viewers own Calendar as if it belonged to that assignee', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['member']); await d.repository.commit(initial); let queries = 0;
    const { screen } = await form(d, 'ios', { readOwnCalendar: async () => { queries++; return { kind: 'clear' }; } });
    await choose(screen, '固定日時に実施'); await screen.change('開始時刻', '19:00'); await screen.change('終了時刻', '19:30');
    assert.ok(screen.text().includes('競合：未確認')); await screen.press('日時を指定・申請する'); assert.equal(queries, 0);
  } finally { d.connection.close(); }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 date submit uses the latest input even when its change and save arrive before the next render`, async () => {
    for (const valid of [true, false]) {
      const f = await fixture(); const d = await f.device();
      try {
        await d.repository.commit(seeds()); const { screen, props } = await form(d, platform);
        const input = screen.nodes().find((n) => n.type === 'TextInput' && n.props.accessibilityLabel === '実施日');
        const submit = screen.button('日時を指定・申請する'); const before = (await listSharingOutbox(d.database, groupId)).length;
        input.props.onChangeText(valid ? '2026-10-29' : '2026-02-30');
        await submit.props.onPress(); await screen.flush();
        if (valid) assert.deepEqual(props.subject.formalDate.target, { precision: 'date', date: '2026-10-29' });
        else { assert.ok(screen.text().includes('日付は年-月-日')); assert.equal((await listSharingOutbox(d.database, groupId)).length, before); }
      } finally { d.connection.close(); }
    }
  });
}

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 date warning cannot confirm a different draft changed before its old confirmation button re-renders`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit([...seeds(), draft('limit', 'settings', 'settings', { heavyDailyLimit: 1 }), draft('heavy', 'chore', 'floor', { load: 'heavy' }),
        draft('mop', 'chore', 'mop', { name: '水拭き', enabled: true, load: 'heavy' }), draft('mop-policy', 'chorePolicy', 'mop', { configuration: seeds()[3].payload.configuration })]);
      const { screen } = await form(d, platform); await screen.press('日時を指定・申請する'); const confirm = screen.button('指定する');
      const input = screen.nodes().find((n) => n.type === 'TextInput' && n.props.accessibilityLabel === '実施日');
      const before = (await listSharingOutbox(d.database, groupId)).length; input.props.onChangeText('2026-10-28');
      await confirm.props.onPress(); await screen.flush(); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
      await screen.press('日時を指定・申請する'); assert.ok(screen.text().includes('端末に保存'));
    } finally { d.connection.close(); }
  });
}
