import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, draft, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { rotationFixture } from './helpers/sharing-v2-rotation-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { commonFrames, commonFrame } from '../src/features/sharing/v2/common-frames.ts';
import { nextV2CommonOccurrence } from '../src/features/sharing/v2/next-occurrence.ts';
import { v2ReadPoint } from '../src/features/sharing/v2/view-point.ts';
import { calendarRegistrationDate } from '../src/features/calendar/registration-date.ts';
import { listSharingOutbox, loadSharedFacts, applyReceivedSharedFacts } from '../src/platform/storage/sharing-ledger.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
import { newEventDraft } from '../src/features/calendar/events.ts';

const flush = async ui => { for (let i = 0; i < 18; i++) await ui.flush(); };
const chooseRole = async ui => { ui.nodes().find(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '誰か1人が行う').props.onPress(); await ui.flush(); };
async function setup(t) {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close());
  await d.repository.commit([...seeds(), draft('inactive', 'chore', 'inactive', { name: '窓の清掃', category: '窓', enabled: false, estimatedMinutes: 20, load: 'normal' })]);
  let n = 0; const controller = createV2GroupController(d.repository, { now, makeId: () => `calendar-add-${++n}`, sync: async () => {} });
  const model = await controller.readModel({ from: '2026-10-27', through: '2026-11-30', asOfDate: '2026-10-27' }, { management: true });
  return { d, controller, model };
}

async function calendarBinding(t, platform, database) {
  const { model, controller } = await setup(t); let binding;
  const host = screenHarness('tests/helpers/calendar-source-host.tsx', { platform, exportName: 'CalendarSourceHost',
    props: { model, actions: controller.actions, local: { database, snapshot: await readLocalCalendar(database), loading: false, error: null, refresh: async () => {} },
      capture: value => { binding = value; } } });
  t.after(() => host.unmount()); return binding;
}

test('one-off shared chores converge after completion and undo without inventing later rounds', async t => {
  const h = await rotationFixture(t);
  const ops = await h.a.addConfiguredChore('単発の家事', 1, chorePolicyFromPreset('assigned', ['owner']), { once: true, startDate: '2026-10-27' });
  const id = ops[0].entityId; const ref = { choreId: id, anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
  const read = a => a.readPlan({ from: '2026-10-27', through: '2027-01-27', asOfDate: '2026-10-27' });
  const rows = plan => plan.occurrences.filter(row => row.choreId === id);
  assert.deepEqual(rows(await read(h.a)).map(row => row.anchorDate), ['2026-10-27']);
  const [done] = await h.a.complete(ref);
  await h.deliver(h.owner, await h.load(h.owner)); await h.deliver(h.member);
  assert.equal(rows(await read(h.b)).length, 1); assert.equal(rows(await read(h.b))[0].completed, true);
  await h.a.undo(done.operationId); await h.deliver(h.owner, await h.load(h.owner)); await h.deliver(h.member);
  assert.equal(rows(await read(h.b)).length, 1); assert.equal(rows(await read(h.b))[0].completed, false);
  const later = await h.a.readPlan({ from: '2026-11-20', through: '2027-01-27', asOfDate: '2026-11-20' });
  assert.ok(later.occurrences.filter(row => row.choreId === id).every(row => row.anchorDate === ref.anchorDate));
  const state = await h.owner.repository.readState();
  assert.throws(() => nextV2CommonOccurrence(state.assessment.view, v2ReadPoint(state.assessment.view, state.archive.at(-1)), id, ref.anchorDate), /次回/);
  await h.a.patchChoreConfiguration(id, 1, { once: false, intervalDays: 7 }, '2026-10-27');
  assert.deepEqual(rows(await read(h.a)).slice(0, 3).map(row => row.anchorDate), ['2026-10-27', '2026-11-03', '2026-11-10']);
});

test('one-off recurrence rejects invented anchors, conflicting monthly flags, and writes under old group epochs', async t => {
  const cfg = { policy: chorePolicyFromPreset('common'), anchorDate: '2026-10-27', intervalDays: 1, once: true, windowBeforeDays: 0, windowAfterDays: 0, ruleVersion: 1 };
  assert.deepEqual(commonFrames('group', 'chore', cfg, '2026-10-27', '2027-10-27').map(row => row.anchorDate), ['2026-10-27']);
  assert.deepEqual(commonFrames('group', 'chore', cfg, '2026-10-28', '2027-10-27'), []);
  assert.throws(() => commonFrame('group', 'chore', cfg, '2026-10-28'));
  for (const schedulerVersion of ['liflow-shared-2-draft-54', 'liflow-shared-2-draft-55']) {
    const f = await fixture({ schedulerVersion }); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
    let n = 0; const actions = createV2PlannerActions(d.repository, { now, makeId: () => `old-calendar-${++n}` });
    const before = (await listSharingOutbox(d.database, groupId)).length;
    await assert.rejects(actions.addConfiguredChore('単発', 1, cfg.policy, { once: true }), { code: 'sharing/v2-authority-denied' });
    assert.throws(() => actions.addConfiguredChore('不正な繰り返し', 1, cfg.policy, { once: true, monthly: true }), /繰り返し/);
    assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
  }
  assert.equal(calendarRegistrationDate('2026-02-30'), undefined); assert.equal(calendarRegistrationDate(['2026-11-05']), undefined);
  assert.equal(calendarRegistrationDate('2026-11-05'), '2026-11-05');
});

test('calendar chore creation atomically stores timed designations and converges without duplicate calendar events', async t => {
  const h = await rotationFixture(t); const timing = { allDay: false, startMinute: 1140, endMinute: 1200, endDayOffset: 0, timeZone: 'Asia/Tokyo' };
  const operations = await h.a.addConfiguredChore('時間を指定する家事', 1, chorePolicyFromPreset('common'), { once: true, startDate: '2026-10-27', calendarTiming: timing });
  const id = operations[0].entityId;
  await h.deliver(h.owner, await h.load(h.owner)); await h.deliver(h.member);
  const plan = await h.b.readPlan({ from: '2026-10-27', through: '2026-11-27', asOfDate: '2026-10-27' });
  const rounds = plan.occurrences.filter(row => row.choreId === id); assert.equal(rounds.length, 1);
  const formal = rounds[0].subjects[0].formalDate;
  assert.equal(formal.kind, 'manual'); assert.equal(formal.mode, 'fixed');
  assert.deepEqual(formal.target, { precision: 'interval', start: '2026-10-27T10:00:00.000Z', end: '2026-10-27T11:00:00.000Z' });
  assert.equal((await h.owner.repository.readState()).assessment.view.ofType('calendarEvent').length, 0);
  const before = (await h.load(h.owner)).length;
  await assert.rejects(h.a.addConfiguredChore('時刻が無効な家事', 1, chorePolicyFromPreset('common'), { once: true, startDate: '2026-10-27', calendarTiming: { ...timing, endMinute: 1000 } }), /終了/);
  assert.equal((await h.load(h.owner)).length, before, 'a rejected interval leaves no partial chore or outbox');
  const recurring = await h.a.addConfiguredChore('毎週の時間指定', 7, chorePolicyFromPreset('eachMember'), { startDate: '2026-10-27', calendarTiming: timing });
  const weekly = await h.a.readPlan({ from: '2026-11-03', through: '2026-11-03', asOfDate: '2026-10-27' });
  for (const subject of weekly.occurrences.find(row => row.choreId === recurring[0].entityId).subjects) {
    assert.equal(subject.formalDate.kind, 'manual'); assert.equal(subject.formalDate.target.start, '2026-11-03T10:00:00.000Z');
  }
  const rangeOps = await h.a.addConfiguredChore('日をまたぐ時間指定', 1, chorePolicyFromPreset('common'), { once: true, startDate: '2026-10-27', windowAfterDays: 2,
    calendarTiming: { ...timing, startMinute: 0, endMinute: 0, endDayOffset: 2 } });
  const range = await h.a.readPlan({ from: '2026-10-27', through: '2026-10-29', asOfDate: '2026-10-28' });
  const subject = range.occurrences.find(row => row.choreId === rangeOps[0].entityId).subjects[0];
  assert.equal(subject.executionWindowStart, '2026-10-27'); assert.equal(subject.executionWindowEnd, '2026-10-28');
  assert.equal(subject.virtuallyConsumed, false);
});

test('timed per-member chore creation designates only its configured participants and converges without extra subjects', async t => {
  const h = await rotationFixture(t);
  const timing = { allDay: false, startMinute: 600, endMinute: 615, endDayOffset: 0, timeZone: 'Asia/Tokyo' };
  const policy = { completion: 'perMember', assignment: { mode: 'selected', memberIds: ['member'] } };
  const operations = await h.a.addConfiguredChore('指定した人だけの家事', 1, policy, { once: true, startDate: '2026-10-27', calendarTiming: timing });
  const id = operations[0].entityId;
  assert.deepEqual(operations.filter(op => op.entityType === 'designation').map(op => op.payload.configuration.subjectUserId), ['member']);
  await h.deliver(h.owner, await h.load(h.owner)); await h.deliver(h.member);
  const range = { from: '2026-10-27', through: '2026-11-27', asOfDate: '2026-10-27' };
  const own = (await h.a.readPlan(range)).occurrences.find(row => row.choreId === id);
  const other = (await h.b.readPlan(range)).occurrences.find(row => row.choreId === id);
  assert.deepEqual(other, own);
  assert.deepEqual(other.subjects.map(subject => subject.subjectUserId), ['member']);
  assert.equal(other.subjects[0].formalDate.target.start, '2026-10-27T01:00:00.000Z');
});

test('combined calendar date and assignment edits reject unauthorized or stale input without partially saving', async t => {
  const f = await fixture(); const owner = await f.device(); t.after(() => owner.connection.close()); await owner.repository.commit(seeds());
  for (const userId of ['owner', 'member']) {
    const d = userId === 'owner' ? owner : await f.device(userId, f[userId]);
    if (userId !== 'owner') { t.after(() => d.connection.close()); const facts = await loadSharedFacts(owner.database, groupId);
      await applyReceivedSharedFacts(d.database, groupId, facts, '1', d.repository.project, null, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts))); }
    let id = 0; const actions = createV2PlannerActions(d.repository, { now, makeId: () => `combined-${userId}-${++id}` });
    const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
    const input = { mode: 'day', target: { precision: 'date', date: '2026-10-28' }, assigneeIds: [userId], expectedAssigneeIds: [], expectedAssignmentIds: [], expectedConflictIds: [], expectedClaimIds: [] };
    const before = (await listSharingOutbox(d.database, groupId)).length;
    if (userId === 'member') await assert.rejects(actions.changeDate(ref, input), /権限/);
    else {
      await assert.rejects(actions.changeDate(ref, { ...input, assigneeIds: ['missing'] }), /担当者/);
      await assert.rejects(actions.changeDate(ref, { ...input, expectedClaimIds: ['stale-claim'] }), { code: 'sharing/v2-stale-settings' });
      await assert.rejects(actions.changeDate(ref, { ...input, expectedAssignmentIds: undefined }), { code: 'sharing/v2-stale-settings' });
    }
    assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    assert.equal((await d.repository.readState()).assessment.view.ofType('designation').length, 0);
    assert.equal((await d.repository.readState()).assessment.view.ofType('assignmentRule').length, 0);
  }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} calendar registration reuses an inactive chore definition and adds exactly one chosen day`, async t => {
    const { d, controller, model } = await setup(t); const created = []; const opened = [];
    const ui = screenHarness('src/features/sharing/v2-ui/add-chore.tsx', { exportName: 'V2AddChore', platform,
      props: { model, actions: controller.actions, busy: false, run: work => work(), calendarDate: '2026-11-05', onCreated: id => created.push(id), onBack() {}, onOpenScheduled: (...args) => opened.push(args) } });
    t.after(() => ui.unmount()); const before = (await d.repository.readState()).assessment.view.ofType('chore').length;
    await ui.change('追加する既存の家事を検索', '窓の清掃'); await ui.press('窓の清掃を選択');
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '追加する家事の周期'), false);
    await chooseRole(ui); const save = ui.button('追加'); save.props.onPress(); save.props.onPress(); await flush(ui);
    assert.deepEqual(created, ['inactive']); assert.deepEqual(opened, []);
    const state = await d.repository.readState();
    assert.equal(state.assessment.view.ofType('chore').filter(op => op.entityId === 'inactive' && op.payload.name).length, 1);
    assert.equal(state.assessment.view.ofType('chore').filter(op => op.payload.name).length, before);
    const plan = await controller.actions.readPlan({ from: '2026-10-27', through: '2026-12-27', asOfDate: '2026-10-27' });
    assert.deepEqual(plan.occurrences.filter(row => row.choreId === 'inactive').map(row => row.anchorDate), ['2026-11-05']);
  });
  test(`${platform} existing recurring calendar chores open their real round without writing duplicate definitions or schedules`, async t => {
    const { d, controller, model } = await setup(t); const opened = [];
    const ui = screenHarness('src/features/sharing/v2-ui/add-chore.tsx', { exportName: 'V2AddChore', platform,
      props: { model, actions: controller.actions, busy: false, run: work => work(), calendarDate: '2026-11-05', onCreated() {}, onBack() {}, onOpenScheduled: (...args) => opened.push(args) } });
    t.after(() => ui.unmount()); const before = (await listSharingOutbox(d.database, groupId)).length;
    await ui.change('追加する既存の家事を検索', '床を掃除する'); await ui.press('床を掃除するを選択'); assert.deepEqual(opened.map(([id, date]) => [id, date]), [['floor', '2026-11-05']]);
    assert.deepEqual(opened[0][2].clocks, { start: null, end: null });
    assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
  });
  test(`${platform} registering a past one-off chore keeps the selected day rather than dropping its only occurrence`, async t => {
    const { d, controller, model } = await setup(t); const created = [];
    const ui = screenHarness('src/features/sharing/v2-ui/add-chore.tsx', { exportName: 'V2AddChore', platform,
      props: { model, actions: controller.actions, busy: false, run: work => work(), calendarDate: '2026-10-26', onCreated: id => created.push(id), onBack() {} } });
    t.after(() => ui.unmount()); await ui.change('追加する既存の家事を検索', '窓の清掃'); await ui.press('窓の清掃を選択'); await chooseRole(ui); await ui.press('追加'); await flush(ui);
    assert.deepEqual(created, ['inactive']);
    const plan = await controller.actions.readPlan({ from: '2026-10-26', through: '2026-11-27', asOfDate: '2026-10-27' });
    assert.deepEqual(plan.occurrences.filter(row => row.choreId === 'inactive').map(row => row.anchorDate), ['2026-10-26']);
    assert.equal((await d.repository.readState()).assessment.view.ofType('chorePolicy').find(row => row.entityId === 'inactive').payload.configuration.effectiveFrom, '2026-10-26');
  });
  test(`${platform} new calendar chores default to one day and can opt into monthly recurrence before one atomic save`, async t => {
    for (const monthly of [false, true]) {
      const { d, controller, model } = await setup(t); const created = [];
      const ui = screenHarness('src/features/sharing/v2-ui/add-chore.tsx', { exportName: 'V2AddChore', platform,
        props: { model, actions: controller.actions, busy: false, run: work => work(), calendarDate: '2026-11-05', onCreated: id => created.push(id), onBack() {} } });
      t.after(() => ui.unmount()); await ui.press('新しい家事を作る'); await ui.change('追加する家事の名前', '片づけ'); await chooseRole(ui);
      if (monthly) { ui.nodes().find(node => node.props.accessibilityLabel === '追加する家事を繰り返す' && node.props.onPress).props.onPress(); await ui.flush(); await ui.press('毎月'); }
      await ui.press('追加'); await flush(ui); assert.equal(created.length, 1);
      const state = await d.repository.readState(); const cfg = state.assessment.view.ofType('chorePolicy').find(op => op.entityId === created[0]).payload.configuration;
      assert.equal(cfg.once === true, !monthly); assert.equal(cfg.monthly === true, monthly); assert.equal(cfg.anchorDate, '2026-11-05');
      assert.equal(state.assessment.view.ofType('designation').filter(op => op.payload.configuration.choreId === created[0]).length, 0, 'new chores with blank clocks do not acquire a fixed time');
    }
  });
  test(`${platform} switching a shared appointment to chore registration preserves typed appointment input and never saves a fake calendar event`, async t => {
    const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
    const calls = []; const navigations = []; let registration;
    const local = await calendarBinding(t, platform, h.database);
    const initial = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', audience: 'group',
      groupId: local.shared.groupId, ownerScope: local.shared.notificationScope, value: newEventDraft('2026-11-05', 'Asia/Tokyo') };
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform,
      navigate: (...args) => navigations.push(args), props: { local, initial, onClose: () => calls.push('close'), onSaved: () => calls.push('event-save'),
        renderChoreRegistration: props => { registration = props; return { type: 'Pressable', props: { accessibilityRole: 'button', accessibilityLabel: '家事選択を閉じる', onPress: props.onBack } }; } } });
    t.after(() => ui.unmount()); await ui.change('予定名', '入力を保持');
    assert.equal(ui.button('家事を追加').props.accessibilityState?.selected, undefined);
    await ui.press('家事を追加'); await flush(ui);
    assert.deepEqual(calls, []); assert.equal(registration.date, '2026-11-05'); assert.deepEqual(navigations, []);
    assert.equal(ui.nodes().filter(node => node.type === 'Modal').length, 1, 'chore selection stays inside the original sheet');
    const snapshot = await readLocalCalendar(h.database, initial.ownerScope);
    assert.equal(snapshot.events.length, 0); assert.equal(snapshot.draft.value.title, '入力を保持'); assert.equal(snapshot.draft.ownerScope, initial.ownerScope);
    registration.onBusyChange(true); await ui.flush();
    ui.nodes().find(node => node.type === 'Modal').props.onRequestClose(); registration.onBack(); await ui.flush();
    assert.deepEqual(calls, []); assert.ok(ui.nodes().some(node => node.props.accessibilityLabel === '家事選択を閉じる'));
    registration.onBusyChange(false); await ui.flush();
    await ui.press('家事選択を閉じる');
    assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === '予定名').props.defaultValue, '入力を保持');
    assert.deepEqual(calls, []); assert.deepEqual(navigations, []);
  });
  test(`${platform} shared calendar chore selection uses its existing sheet without navigating to add or date routes`, async t => {
    const { controller, model } = await setup(t); const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
    const local = { database: h.database, snapshot: await readLocalCalendar(h.database), loading: false, error: null, refresh: async () => {} };
    const navigations = [];
    const ui = screenHarness('src/features/sharing/v2-ui/calendar.tsx', { exportName: 'V2Calendar', platform,
      navigate: (...args) => navigations.push(args), props: { model, actions: controller.actions, busy: false, run: work => work(), local,
        month: '2026-10-01', selectedDate: '2026-10-28', onMonth() {}, onSelectDate() {}, onRound() {} } });
    t.after(() => ui.unmount()); await ui.press('予定を追加'); await ui.press('グループ共通'); await ui.press('家事を追加');
    await ui.press('前の画面に戻る'); assert.ok(ui.nodes().some(node => node.props.accessibilityLabel === '予定名'));
    await ui.press('家事を追加'); await ui.change('追加する既存の家事を検索', '床を掃除する'); await ui.press('床を掃除するを選択');
    assert.ok(ui.nodes().some(node => node.props.accessibilityLabel === '予定を保存'));
    assert.equal(ui.nodes().filter(node => node.type === 'Modal').length, 1);
    assert.equal(ui.text().includes('家事の日付変更'), false); assert.equal(ui.text().includes('追加する家事の名前'), false);
    assert.deepEqual(navigations, []);
    await ui.press('予定の編集を閉じる'); assert.deepEqual(navigations, []);
    assert.equal((await readLocalCalendar(h.database)).events.length, 0);
  });
  test(`${platform} inactive chore sheet saves the edited date and leaves its existing definition intact`, async t => {
    const { d, controller, model } = await setup(t); const saved = []; let picker;
    const ui = screenHarness('src/features/sharing/v2-ui/calendar-chore-registration.tsx', { exportName: 'V2CalendarChoreRegistration', platform,
      datePicker: options => { picker = options; }, props: { model, actions: controller.actions, busy: false, run: work => work(), date: '2026-10-28',
        onBack() {}, onClose() {}, onSaved: date => saved.push(date), onBusyChange() {} } });
    t.after(() => ui.unmount());
    await ui.change('追加する既存の家事を検索', '窓の清掃'); await ui.press('窓の清掃を選択'); await ui.press('家事の詳細設定'); await chooseRole(ui);
    await ui.press('開始日を選択');
    if (platform === 'ios') {
      ui.nodes().find(node => node.type === 'DateTimePicker').props.onValueChange({ type: 'set' }, new Date('2026-10-29T12:00:00Z')); await ui.flush();
      await ui.press('開始日の選択を完了');
    } else { picker.onValueChange({ type: 'set' }, new Date('2026-10-29T12:00:00Z')); await ui.flush(); }
    await ui.press('予定を保存'); await flush(ui); assert.deepEqual(saved, ['2026-10-29']);
    const state = await d.repository.readState();
    assert.equal(state.assessment.view.ofType('chore').filter(row => row.entityId === 'inactive' && row.payload.name).length, 1);
    assert.equal(state.assessment.view.ofType('chorePolicy').find(row => row.entityId === 'inactive').payload.configuration.anchorDate, '2026-10-29');
  });
  test(`${platform} choosing a scheduled chore edits its real round inside the calendar sheet and returns the saved date`, async t => {
    const { d, controller, model } = await setup(t); const saved = []; const navigations = []; const busy = []; let picker;
    const ui = screenHarness('src/features/sharing/v2-ui/calendar-chore-registration.tsx', { exportName: 'V2CalendarChoreRegistration', platform,
      datePicker: options => { picker = options; }, navigate: (...args) => navigations.push(args), props: {
        model, actions: controller.actions, busy: false, run: work => work(), date: '2026-10-28',
        onBack() {}, onClose() {}, onSaved: date => saved.push(date), onBusyChange: value => busy.push(value),
      } });
    t.after(() => ui.unmount());
    const before = (await listSharingOutbox(d.database, groupId)).length;
    await ui.change('追加する既存の家事を検索', '床を掃除する'); await ui.press('床を掃除するを選択');
    assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === '追加する家事を選び直す').props.accessibilityValue.text, '床を掃除する'); assert.ok(ui.text().includes('予定を追加')); assert.deepEqual(navigations, []);
    assert.equal((await listSharingOutbox(d.database, groupId)).length, before, 'selection does not change an existing round');
    await ui.press('開始日を選択');
    if (platform === 'ios') {
      ui.nodes().find(node => node.type === 'DateTimePicker').props.onValueChange({ type: 'set' }, new Date('2026-10-29T12:00:00Z')); await ui.flush();
      await ui.press('開始日の選択を完了');
    } else { picker.onValueChange({ type: 'set' }, new Date('2026-10-29T12:00:00Z')); await ui.flush(); }
    const save = ui.button('予定を保存'); save.props.onPress(); save.props.onPress(); await flush(ui);
    if (ui.nodes().some(node => node.props.accessibilityRole === 'button' && node.props.title === '指定する')) { await ui.press('指定する'); await flush(ui); }
    assert.deepEqual(saved, ['2026-10-29']); assert.deepEqual(navigations, []); assert.deepEqual(busy, [true, false]);
    const state = await d.repository.readState();
    assert.equal(state.assessment.view.ofType('chorePolicy').filter(row => row.entityId === 'floor').length, 1);
    assert.equal(state.assessment.view.ofType('calendarEvent').length, 0);
    assert.equal(state.assessment.view.ofType('designation').length, 1);
    assert.deepEqual(state.assessment.view.ofType('designation')[0].payload.configuration.target, { precision: 'date', date: '2026-10-29' }, 'an unselected clock remains a date-only chore');
  });
  test(`${platform} chore sheet save errors stay visible and choosing again returns to the picker rather than new-chore input`, async t => {
    const { d, controller, model } = await setup(t); const saved = []; const navigations = [];
    const ui = screenHarness('src/features/sharing/v2-ui/calendar-chore-registration.tsx', { exportName: 'V2CalendarChoreRegistration', platform,
      navigate: (...args) => navigations.push(args), props: { model, actions: { ...controller.actions, changeDate: async () => { throw new Error('検査用の保存エラー'); } }, busy: false,
        run: async work => { try { await work(); } catch {} }, date: '2026-10-28', onBack() {}, onClose() {}, onSaved: date => saved.push(date), onBusyChange() {} } });
    t.after(() => ui.unmount()); const before = (await listSharingOutbox(d.database, groupId)).length;
    await ui.change('追加する既存の家事を検索', '床を掃除する'); await ui.press('床を掃除するを選択'); await ui.press('予定を保存'); await flush(ui);
    assert.ok(ui.text().includes('検査用の保存エラー')); assert.deepEqual(saved, []); assert.deepEqual(navigations, []);
    assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    await ui.press('追加する家事を選び直す'); assert.ok(ui.nodes().some(node => node.props.accessibilityLabel === '追加する既存の家事を検索'));
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '追加する家事の名前'), false);
  });
  test(`${platform} chore details keep recurrence optional inside the original appointment form and save the selected existing definition`, async t => {
    const { d, controller, model } = await setup(t); const saved = [];
    const ui = screenHarness('src/features/sharing/v2-ui/calendar-chore-registration.tsx', { exportName: 'V2CalendarChoreRegistration', platform,
      props: { model, actions: controller.actions, busy: false, run: work => work(), date: '2026-10-28', onBack() {}, onClose() {}, onSaved: date => saved.push(date), onBusyChange() {} } });
    t.after(() => ui.unmount()); const before = (await listSharingOutbox(d.database, groupId)).length;
    await ui.change('追加する既存の家事を検索', '窓の清掃'); await ui.press('窓の清掃を選択');
    assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === '追加する家事を選び直す').props.accessibilityValue.text, '窓の清掃');
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '追加する家事を繰り返す'), false);
    await ui.press('家事の詳細設定');
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '追加する家事の周期'), false);
    ui.nodes().find(node => node.props.accessibilityLabel === '追加する家事を繰り返す' && node.props.onPress).props.onPress(); await ui.flush();
    assert.ok(ui.nodes().some(node => node.props.accessibilityLabel === '追加する家事の周期'));
    await ui.press('毎月');
    assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    await ui.press('予定を保存'); await flush(ui); assert.deepEqual(saved, ['2026-10-28']);
    const state = await d.repository.readState();
    assert.equal(state.assessment.view.ofType('chore').filter(op => op.entityId === 'inactive' && op.payload.name).length, 1);
    assert.equal(state.assessment.view.ofType('calendarEvent').length, 0);
    assert.equal(state.assessment.view.ofType('chorePolicy').find(op => op.entityId === 'inactive').payload.configuration.monthly, true);
  });
  test(`${platform} calendar saves an existing round date and its assignees atomically without changing its recurring policy`, async t => {
    const { d, controller, model } = await setup(t); const saved = [];
    const ui = screenHarness('src/features/sharing/v2-ui/calendar-chore-registration.tsx', { exportName: 'V2CalendarChoreRegistration', platform,
      props: { model, actions: controller.actions, busy: false, run: work => work(), date: '2026-10-28', onBack() {}, onClose() {}, onSaved: date => saved.push(date), onBusyChange() {} } });
    t.after(() => ui.unmount()); const before = (await listSharingOutbox(d.database, groupId)).length;
    await ui.change('追加する既存の家事を検索', '床を掃除する'); await ui.press('床を掃除するを選択'); await ui.press('家事の詳細設定');
    ui.nodes().find(node => node.props.accessibilityLabel?.startsWith('この回の担当：') && node.props.onPress).props.onPress(); await ui.flush();
    assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    await ui.press('予定を保存'); await flush(ui); assert.deepEqual(saved, ['2026-10-28']);
    const state = await d.repository.readState();
    assert.equal(state.assessment.view.ofType('chorePolicy').filter(op => op.entityId === 'floor').length, 1);
    const assignment = state.assessment.view.ofType('assignmentRule'); const designation = state.assessment.view.ofType('designation');
    assert.equal(assignment.length, 1); assert.equal(designation.length, 1); assert.equal(assignment[0].payload.scope, 'once');
    assert.equal(assignment[0].payload.fromOccurrenceId, designation[0].payload.configuration.selector.occurrenceId);
    assert.equal(assignment[0].payload.memberIds.length, 1);
  });
  test(`${platform} turning repeat on for an existing round preserves the definition and reveals editable cadence without collapsing details`, async t => {
    const { d, controller, model } = await setup(t); const saved = [];
    const ui = screenHarness('src/features/sharing/v2-ui/calendar-chore-registration.tsx', { exportName: 'V2CalendarChoreRegistration', platform,
      props: { model, actions: controller.actions, busy: false, run: work => work(), date: '2026-10-28', onBack() {}, onClose() {}, onSaved: date => saved.push(date), onBusyChange() {} } });
    t.after(() => ui.unmount()); await ui.change('追加する既存の家事を検索', '床を掃除する'); await ui.press('床を掃除するを選択'); await ui.press('家事の詳細設定');
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '追加する家事の周期'), false);
    ui.nodes().find(node => node.props.accessibilityLabel === '追加する家事を繰り返す' && node.props.onPress).props.onPress(); await ui.flush();
    assert.equal(ui.button('家事の詳細設定').props.accessibilityState.expanded, true);
    assert.ok(ui.nodes().some(node => node.props.accessibilityLabel === '追加する家事の周期'));
    await ui.press('毎月'); await ui.press('予定を保存'); await flush(ui); assert.deepEqual(saved, ['2026-10-28']);
    const state = await d.repository.readState(); const configurations = state.assessment.view.ofType('chorePolicy').filter(op => op.entityId === 'floor');
    assert.equal(configurations.length, 2); assert.equal(configurations.at(-1).payload.configuration.monthly, true);
    assert.equal(state.assessment.view.ofType('chore').filter(op => op.entityId === 'floor' && op.payload.name).length, 1);
    assert.equal(state.assessment.view.ofType('calendarEvent').length, 0);
  });
  test(`${platform} calendar chore choices reveal one category or search directly while retaining exact chore identity`, async () => {
    const first = { id: 'custom.room', name: '片付け', category: '居室' };
    const second = { id: 'custom.bath', name: '片付け', category: '水回り' };
    const retired = { id: 'retired', name: '古い家事', category: '居室', archived: true };
    const picked = []; let created = 0; let closed = 0;
    const ui = screenHarness('src/features/sharing/v2-ui/calendar-chore-picker.tsx', { exportName: 'CalendarChorePicker', platform,
      props: { chores: [first, second, retired], onSelect: chore => picked.push(chore), onNew: () => created++, onClose: () => closed++ } });
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '片付けを選択'), false);
    await ui.press('部屋・玄関の家事を開く'); await ui.press('片付けを選択'); assert.equal(picked.at(-1), first);
    await ui.press('部屋・玄関の家事を閉じる');
    await ui.change('追加する既存の家事を検索', '浴室・トイレ'); await ui.press('片付けを選択'); assert.equal(picked.at(-1), second);
    await ui.change('追加する既存の家事を検索', '片付け');
    assert.equal(ui.nodes().filter(node => node.props.accessibilityLabel === '片付けを選択').length, 2, 'same names in different chores remain separate choices');
    await ui.change('追加する既存の家事を検索', '古い家事'); assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '古い家事を選択'), false);
    await ui.change('追加する既存の家事を検索', ''); assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '片付けを選択'), false);
    await ui.press('新しい家事を作る'); await ui.press('前の画面に戻る'); assert.equal(created, 1); assert.equal(closed, 1);
  });
  test(`${platform} the calendar date shortcut changes only the existing round and returns after a durable save`, async t => {
    const { d, controller, model } = await setup(t); const returned = [];
    const round = model.plan.occurrences.find(row => row.choreId === 'floor' && row.anchorDate === '2026-10-27'); const subject = round.subjects[0];
    const ui = screenHarness('src/features/sharing/v2-ui/date-form.tsx', { exportName: 'V2DateForm', platform,
      props: { model, round, subject, actions: controller.actions, busy: false, run: work => work(), initialDate: '2026-10-28', onSaved: () => returned.push('calendar') } });
    t.after(() => ui.unmount());
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '変更後の実施日を選択'), true);
    assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '無期限'), false);
    await ui.press('この日に変更'); await flush(ui); assert.deepEqual(returned, ['calendar']);
    const state = await d.repository.readState(); assert.equal(state.assessment.view.ofType('chorePolicy').filter(row => row.entityId === 'floor').length, 1);
    assert.equal(state.assessment.view.ofType('calendarEvent').length, 0);
    const rule = state.assessment.view.ofType('designation').find(row => row.payload.configuration.choreId === 'floor').payload.configuration;
    assert.equal(rule.selector.scope, 'once'); assert.equal(rule.selector.occurrenceId, round.id); assert.deepEqual(rule.target, { precision: 'date', date: '2026-10-28' });
  });
}

for (const platform of ['ios', 'android']) {
  test(`${platform} clearing a chosen chore resets appointment input and dates without keeping its saved draft or interrupting an in-flight save`, async t => {
    const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
    const local = await calendarBinding(t, platform, h.database);
    for (const audience of ['personal', 'group']) {
      let registration; let picker; const calls = [];
      const initial = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', audience,
        ...(audience === 'group' ? { groupId: local.shared.groupId, ownerScope: local.shared.notificationScope } : {}), value: newEventDraft('2026-11-05', 'Asia/Tokyo') };
      const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, datePicker: options => { picker = options; }, props: {
        local, initial, onClose: () => calls.push('close'), onSaved: () => calls.push('save'), renderChoreRegistration: props => { registration = props; return { type: 'View', props: {} }; },
      } });
      t.after(() => ui.unmount()); await ui.change('予定名', '残さない予定'); await ui.change('予定の場所', '残さない場所'); await ui.change('予定のメモ', '残さないメモ');
      await ui.press('開始日を選択');
      if (platform === 'ios') { ui.nodes().find(node => node.type === 'DateTimePicker').props.onValueChange({ type: 'set' }, new Date('2026-11-09T12:00:00Z')); await ui.flush(); await ui.press('開始日の選択を完了'); }
      else { picker.onValueChange({ type: 'set' }, new Date('2026-11-09T12:00:00Z')); await ui.flush(); }
      assert.equal(ui.button('開始日を選択').props.accessibilityValue.text, '2026/11/09');
      await ui.press('家事を追加'); await flush(ui); registration.onBusyChange(true); await ui.flush(); registration.onCancel(); await ui.flush();
      assert.equal(ui.nodes().some(node => node.props.accessibilityLabel === '予定名'), false);
      registration.onBusyChange(false); await ui.flush(); registration.onCancel(); await flush(ui);
      for (const label of ['予定名', '予定の場所', '予定のメモ']) assert.equal(ui.nodes().find(node => node.props.accessibilityLabel === label).props.defaultValue, '');
      assert.equal(ui.button('開始日を選択').props.accessibilityValue.text, '2026/11/05');
      assert.equal(ui.button('終了日を選択').props.accessibilityValue.text, '2026/11/05');
      const snapshot = await readLocalCalendar(h.database, local.shared.notificationScope);
      assert.equal(snapshot.draft, null); assert.equal(snapshot.events.length, 0); assert.deepEqual(calls, []);
      ui.unmount();
    }
  });
  test(`${platform} shared chore clocks start blank and save no partial time while chosen times keep duration`, async t => {
    const { d, controller, model } = await setup(t); let picker; const saved = [];
    const ui = screenHarness('src/features/sharing/v2-ui/calendar-chore-registration.tsx', { exportName: 'V2CalendarChoreRegistration', platform, datePicker: options => { picker = options; }, props: {
      model, actions: controller.actions, busy: false, run: work => work(), date: '2026-10-28', onBack() {}, onClose() {}, onSaved: date => saved.push(date), onBusyChange() {},
    } }); t.after(() => ui.unmount());
    await ui.change('追加する既存の家事を検索', '床を掃除する'); await ui.press('床を掃除するを選択'); assert.equal(ui.button('開始を選択').props.accessibilityValue.text, '未指定'); assert.equal(ui.button('終了を選択').props.accessibilityValue.text, '未指定');
    const pick = async (label, clock) => {
      await ui.press(`${label}を選択`); const date = new Date(`2026-10-28T${clock}:00Z`);
      if (platform === 'ios') { ui.nodes().find(node => node.type === 'DateTimePicker').props.onValueChange({ type: 'set' }, date); await ui.flush(); await ui.press(`${label}の選択を完了`); }
      else { picker.onValueChange({ type: 'set' }, date); await ui.flush(); }
    };
    await pick('開始', '19:00'); assert.equal(ui.button('終了を選択').props.accessibilityValue.text, '未指定');
    const before = (await listSharingOutbox(d.database, groupId)).length; await ui.press('予定を保存'); await flush(ui);
    assert.ok(ui.text().includes('開始時刻と終了時刻を両方選んでください')); assert.deepEqual(saved, []); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    await pick('終了', '20:30'); await pick('開始', '20:00'); assert.equal(ui.button('終了を選択').props.accessibilityValue.text, '21:30');
    await ui.press('予定を保存'); await flush(ui);
    if (ui.nodes().some(node => node.props.accessibilityRole === 'button' && node.props.title === '指定する')) { await ui.press('指定する'); await flush(ui); }
    assert.deepEqual(saved, ['2026-10-28']);
    const state = await d.repository.readState(); const target = state.assessment.view.ofType('designation').at(-1).payload.configuration.target;
    assert.deepEqual(target, { precision: 'interval', start: '2026-10-28T11:00:00.000Z', end: '2026-10-28T12:30:00.000Z' });
    assert.equal(state.assessment.view.ofType('calendarEvent').length, 0);
  });
}
