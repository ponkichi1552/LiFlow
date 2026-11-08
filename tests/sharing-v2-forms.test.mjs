import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId, receiptsFor, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { loadSharedFacts, applyReceivedSharedFacts, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';

const range = { from: '2026-10-20', through: '2026-11-10', asOfDate: '2026-10-27' };
const formFile = 'src/features/sharing/v2-ui/completion-form.tsx';
async function form(d, platform, query = range) {
  let id = 0; const controller = createV2GroupController(d.repository, { makeId: () => `${d.options.userId}-form-${++id}`, now, sync: async () => {} });
  let props;
  const update = async () => { const model = await controller.readModel(query); const round = model.plan.occurrences[0];
    Object.assign(props, { model, round, subject: round.subjects[0] }); };
  const model = await controller.readModel(query); const round = model.plan.occurrences[0];
  props = { model, round, subject: round.subjects[0], actions: controller.actions, now, busy: false, run: async (work) => { await work(); await update(); } };
  const screen = screenHarness(formFile, { exportName: 'V2CompletionForm', props, platform });
  return { props, controller, screen, update };
}
async function select(screen, label) {
  const node = screen.nodes().find((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === label);
  assert.ok(node, `missing choice: ${label}`); assert.equal(node.props.disabled, false); node.props.onPress(); await screen.flush();
}

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 past-work form requires an actual local date and time and stores performer, recorder and original assignment separately`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      const initial = seeds(); initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['member']);
      await d.repository.commit([...initial, draft('owner-name', 'member', 'owner', { userId: 'owner', displayName: '管理者' })]);
      const { screen, props } = await form(d, platform); await select(screen, '以前実施した');
      const initialCount = (await listSharingOutbox(d.database, groupId)).length;
      await screen.press('実施を記録する'); assert.ok(screen.text().includes('日付は年-月-日')); assert.equal((await listSharingOutbox(d.database, groupId)).length, initialCount);
      await screen.change('実施日', '2026-10-27'); await screen.change('実施時刻', '08:30');
      assert.equal((await listSharingOutbox(d.database, groupId)).length, initialCount, 'input alone must not invent a completion');
      await screen.press('実施を記録する'); const record = props.model.plan.history[0];
      assert.equal(record.performedAt, '2026-10-26T23:30:00.000Z'); assert.equal(record.recordedAt, now().toISOString());
      assert.equal(record.performerUserId, 'owner'); assert.equal(record.recorderUserId, 'owner'); assert.deepEqual(record.originalAssigneeIds, ['member']);
      assert.equal(record.acceptance, 'accepted'); assert.equal(props.subject.completed, true); assert.ok(screen.text().includes('端末に保存しました'));
    } finally { d.connection.close(); }
  });
  test(`${platform} v2 work form rejects future and nonexistent local times and a stale assignee without committing a fact or outbox`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      const initial = seeds(); initial[1].payload.timeZone = 'America/New_York'; await d.repository.commit(initial);
      const { screen, controller } = await form(d, platform); await select(screen, '以前実施した');
      const count = (await listSharingOutbox(d.database, groupId)).length;
      await screen.change('実施日', '2026-10-27'); await screen.change('実施時刻', '11:00'); await screen.press('実施を記録する');
      assert.ok(screen.text().includes('現在より前')); assert.equal((await listSharingOutbox(d.database, groupId)).length, count);
      await screen.change('実施時刻', '25:00'); await screen.press('実施を記録する'); assert.ok(screen.text().includes('00:00〜23:59'));
      await screen.change('実施日', '2026-03-08'); await screen.change('実施時刻', '02:30');
      await screen.press('実施を記録する'); assert.ok(screen.text().includes('存在しない時刻')); assert.equal((await listSharingOutbox(d.database, groupId)).length, count);
      await controller.actions.assign({ choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null }, ['member'], 'this', true);
      await select(screen, '今実施した'); await assert.rejects(screen.press('実施を記録する'), { code: 'sharing/v2-stale-settings' });
      assert.equal((await controller.readModel(range)).plan.history.length, 0);
    } finally { d.connection.close(); }
  });
}

test('v2 a restricted substitute uses the work form to retain a real report awaiting approval and cannot impersonate another performer', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    const initial = seeds(); initial[0].payload.configuration.allowSubstitution = false;
    initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['owner']); await owner.repository.commit(initial);
    const facts = await loadSharedFacts(owner.database, groupId);
    await applyReceivedSharedFacts(member.database, groupId, facts, '4', member.repository.project, null, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(facts)));
    const { screen, props } = await form(member, 'android');
    const choices = screen.nodes().filter((node) => node.props.accessibilityRole === 'radio'); assert.equal(choices.length, 3, 'two time choices and the actual viewer only');
    assert.ok(screen.text().includes('承認までは完了扱いにしません')); await screen.press('実施を記録する');
    const record = props.model.plan.history[0]; assert.equal(record.acceptance, 'pending'); assert.equal(record.performerUserId, 'member');
    assert.equal(record.recorderUserId, 'member'); assert.deepEqual(record.originalAssigneeIds, ['owner']); assert.equal(props.subject.completed, false);
    assert.equal(props.subject.pendingCompletionIds.length, 1);
  } finally { owner.connection.close(); member.connection.close(); }
});

test('v2 a changed group timezone keeps the unsent work input in its original timezone and blocks reinterpretation until reopening', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const { screen, props, update } = await form(d, 'ios');
    await select(screen, '以前実施した'); await screen.change('実施日', '2026-10-27'); await screen.change('実施時刻', '08:00');
    await d.repository.commit([draft('changed-zone', 'settings', 'settings', { timeZone: 'America/New_York' })]); await update(); screen.render();
    assert.ok(screen.text().includes('グループの地域が変更')); assert.ok(screen.text().includes('日時の地域：Asia/Tokyo'));
    assert.equal(screen.nodes().find((node) => node.props.accessibilityLabel === '実施時刻').props.value, '08:00');
    assert.equal(screen.button('実施を記録する').props.disabled, true); assert.equal(props.model.plan.history.length, 0);
    props.model = { ...props.model, plan: { ...props.model.plan, initialized: false } }; screen.render();
    assert.ok(screen.text().includes('地域と基本設定が未確定')); assert.equal(screen.nodes().some((node) => node.type === 'TextInput'), false);
  } finally { d.connection.close(); }
});

test('v2 a past-work form cannot submit against a cadence replaced after its displayed configuration even if the old round ID is still valid', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const { screen, controller } = await form(d, 'ios');
    await select(screen, '以前実施した'); await screen.change('実施日', '2026-10-27'); await screen.change('実施時刻', '08:00');
    await controller.actions.patchChoreConfiguration('floor', 1, { intervalDays: 17 }, '2026-10-27');
    const count = (await listSharingOutbox(d.database, groupId)).length;
    await assert.rejects(screen.press('実施を記録する'), { code: 'sharing/v2-stale-settings' });
    assert.equal((await controller.readModel(range)).plan.history.length, 0); assert.equal((await listSharingOutbox(d.database, groupId)).length, count);
  } finally { d.connection.close(); }
});

test('v2 history displays a restricted substitution as pending and an actual administrator approval completes it without replacing performer or recorder', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    const initial = seeds(); initial[0].payload.configuration.allowSubstitution = false;
    initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['owner']); await owner.repository.commit(initial);
    const initialFacts = await loadSharedFacts(owner.database, groupId);
    await applyReceivedSharedFacts(member.database, groupId, initialFacts, '4', member.repository.project, null, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(initialFacts)));
    const input = await form(member, 'ios'); await input.screen.press('実施を記録する');
    const facts = await loadSharedFacts(member.database, groupId);
    await applyReceivedSharedFacts(owner.database, groupId, facts, '5', owner.repository.project, null, now().getTime(), owner.repository.evidenceForServerReceipts(receiptsFor(facts)));
    const { controller } = await form(owner, 'ios'); let model = await controller.readModel(range);
    const props = { model, record: model.plan.history[0], actions: controller.actions, busy: false,
      run: async (work) => { await work(); model = await controller.readModel(range); Object.assign(props, { model, record: model.plan.history[0] }); } };
    const screen = screenHarness('src/features/sharing/v2-ui/completion-history-card.tsx', { exportName: 'V2CompletionHistoryCard', props });
    assert.ok(screen.text().includes('代行の承認待ち')); assert.equal(screen.text().includes('実施済み'), false);
    await screen.press('代行の実施を承認'); assert.equal(screen.text().includes('代行の承認待ち'), false); assert.equal(props.model.plan.occurrences[0].subjects[0].completed, true);
    assert.equal(props.record.performerUserId, 'member'); assert.equal(props.record.recorderUserId, 'member'); assert.deepEqual(props.record.originalAssigneeIds, ['owner']);
    assert.throws(() => screen.button('この完了を取り消す'), /missing button/);
    await props.run(() => controller.actions.undo(props.record.operationId)); await screen.flush();
    assert.equal(screen.text(), ''); assert.equal(props.model.plan.history.length, 1); assert.equal(props.record.active, false);
  } finally { owner.connection.close(); member.connection.close(); }
});

test('v2 history does not offer another member a cancellation control for work recorded by someone else', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const original = await form(owner, 'ios'); await original.screen.press('実施を記録する');
    const facts = await loadSharedFacts(owner.database, groupId);
    await applyReceivedSharedFacts(member.database, groupId, facts, '5', member.repository.project, null, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(facts)));
    const { controller } = await form(member, 'android'); const model = await controller.readModel(range);
    const screen = screenHarness('src/features/sharing/v2-ui/completion-history-card.tsx', { exportName: 'V2CompletionHistoryCard', props: {
      model, record: model.plan.history[0], actions: controller.actions, busy: false, run: async (work) => work() } });
    assert.ok(screen.text().includes('床を掃除')); assert.equal(model.plan.history[0].active, true); assert.throws(() => screen.button('この完了を取り消す'), /missing button/);
  } finally { owner.connection.close(); member.connection.close(); }
});

test('v2 past-work form requires choosing the repeated clock occurrence and clears that choice when the actual time is edited', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[1].payload.timeZone = 'America/New_York'; initial[1].payload.anchorDate = '2025-11-02';
    initial[3].payload.configuration.anchorDate = '2025-11-02'; await d.repository.commit(initial);
    const query = { from: '2025-11-02', through: '2025-11-03', asOfDate: '2026-10-27' };
    const { screen, props } = await form(d, 'ios', query); await select(screen, '以前実施した');
    await screen.change('実施日', '2025-11-02'); await screen.change('実施時刻', '01:30');
    await screen.press('実施を記録する'); assert.ok(screen.text().includes('どの時刻か')); assert.equal(props.model.plan.history.length, 0);
    await select(screen, '2回目（UTC-05:00）'); await screen.change('実施時刻', '01:45');
    await screen.press('実施を記録する'); assert.ok(screen.text().includes('どの時刻か')); assert.equal(props.model.plan.history.length, 0);
    await select(screen, '2回目（UTC-05:00）'); await screen.press('実施を記録する');
    assert.equal(props.model.plan.history[0].performedAt, '2025-11-02T06:45:00.000Z');
    assert.equal(props.model.plan.history[0].recordedAt, now().toISOString());
  } finally { d.connection.close(); }
});

test('v2 an ambiguous future repeat keeps a real work report unconfirmed and converges through signed SQLite facts without inventing either clock occurrence', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    const initial = seeds(); initial[1].payload.timeZone = 'America/New_York'; initial[1].payload.anchorDate = '2026-10-25'; initial[3].payload.configuration.anchorDate = '2026-10-25';
    await owner.repository.commit(initial); const { controller } = await form(owner, 'ios');
    await controller.actions.changeDate({ choreId: 'floor', anchorDate: '2026-10-25', ruleVersion: 1, subjectUserId: null }, { mode: 'fixed',
      target: { precision: 'interval', start: '2026-10-25T05:30:00.000Z', end: '2026-10-25T05:45:00.000Z' }, selector: { scope: 'ongoing', from: '2026-10-25' } });
    const [work] = await controller.actions.complete({ choreId: 'floor', anchorDate: '2026-11-01', ruleVersion: 1, subjectUserId: null });
    assert.equal(work.payload.recordedInstruction.kind, 'unconfirmed'); assert.equal(work.payload.recordedInstruction.reason, 'ambiguousTime');
    const facts = await loadSharedFacts(owner.database, groupId);
    for (const d of [owner, member]) await applyReceivedSharedFacts(d.database, groupId, facts, '6', d.repository.project, null, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
    const actual = await controller.readModel(range); const other = (await form(member, 'android')).props.model;
    assert.equal(actual.plan.planHash, other.plan.planHash); assert.equal(actual.plan.history[0].instruction.reason, 'ambiguousTime');
    assert.equal(actual.plan.history[0].strictInstructionFulfilled, null); assert.equal(actual.plan.history[0].active, true);
    assert.equal(actual.quarantinedChanges, 0);
  } finally { owner.connection.close(); member.connection.close(); }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 work submit reads an unrendered past-mode selection instead of incorrectly recording work as done now`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds()); const { screen, props } = await form(d, platform);
      const choice = screen.nodes().find((n) => n.props.accessibilityRole === 'radio' && n.props.accessibilityLabel === '以前実施した');
      const submit = screen.button('実施を記録する'); const before = (await listSharingOutbox(d.database, groupId)).length;
      choice.props.onPress(); await submit.props.onPress(); await screen.flush();
      assert.equal(props.model.plan.history.length, 0); assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
      assert.ok(screen.text().includes('日付は年-月-日'));
    } finally { d.connection.close(); }
  });
  test(`${platform} v2 work submit preserves newly typed past details before a rendering turn`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds()); const { screen, props } = await form(d, platform); await select(screen, '以前実施した');
      const submit = screen.button('実施を記録する');
      screen.nodes().find((n) => n.props.accessibilityLabel === '実施日' && n.type === 'TextInput').props.onChangeText('2026-10-27');
      screen.nodes().find((n) => n.props.accessibilityLabel === '実施時刻' && n.type === 'TextInput').props.onChangeText('08:30');
      await submit.props.onPress(); await screen.flush();
      assert.equal(props.model.plan.history[0].performedAt, '2026-10-26T23:30:00.000Z');
    } finally { d.connection.close(); }
  });
}
