import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { decisionFixture as baseFixture, ref, range } from './helpers/sharing-v2-decision-fixture.mjs';
import { groupId, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';

async function decisionFixture(options) {
  const f = await baseFixture(options);
  await f.owner.repository.commit([draft('owner-name', 'member', 'owner', { displayName: 'owner' })]);
  await f.member.repository.commit([draft('member-name', 'member', 'member', { displayName: 'member' })]);
  await f.deliver(f.owner); await f.deliver(f.member);
  return f;
}

async function form(f, who, platform, anchorDate = ref.anchorDate) {
  const controller = who === 'owner' ? f.a : f.b;
  const props = { model: null, round: null, actions: controller.actions, busy: false, run: async (work) => { await work(); await update(); } };
  async function update() { props.model = await controller.readModel(range); props.round = props.model.plan.occurrences.find((round) => round.choreId === 'floor' && round.anchorDate === anchorDate); }
  await update(); assert.ok(props.round);
  const screen = screenHarness('src/features/sharing/v2-ui/assignment-form.tsx', { exportName: 'V2AssignmentForm', props, platform });
  return { screen, props, update: async () => { await update(); screen.render(); } };
}
async function flag(screen, label, value) {
  const node = screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === label); assert.ok(node, `Missing switch ${label}`);
  assert.equal(node.props.disabled, false); node.props.onValueChange(value); await screen.flush();
}
async function requests(f, who, platform) {
  const controller = who === 'owner' ? f.a : f.b;
  const props = { model: await controller.readModel(range), actions: controller.actions, busy: false,
    run: async (work) => { await work(); props.model = await controller.readModel(range); } };
  const screen = screenHarness('src/features/sharing/v2-ui/assignment-requests.tsx', { exportName: 'V2AssignmentRequests', props, platform });
  return { props, screen, update: async () => { props.model = await controller.readModel(range); screen.render(); } };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} v2 assignment selection does not autosave and an explicit one-off change preserves other rounds`, async () => {
    const f = await decisionFixture({ fixed: true });
    try {
      const { screen } = await form(f, 'owner', platform); const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === '担当：owner').props.onValueChange(true);
      screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === '担当：member').props.onValueChange(false);
      assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
      await screen.flush();
      await screen.press('担当変更を保存'); assert.ok(screen.text().includes('端末に保存しました'));
      const state = await f.owner.repository.readState(); const op = state.assessment.view.ofType('assignmentRule').at(-1);
      assert.equal(op.payload.scope, 'once'); assert.deepEqual(op.payload.memberIds, ['owner']); assert.equal(Object.hasOwn(op.payload, 'expectedAssignmentIds'), false);
      const model = await f.a.readModel(range); const round = (day) => model.plan.occurrences.find((entry) => entry.choreId === 'floor' && entry.anchorDate === day);
      assert.deepEqual(round(ref.anchorDate).assigneeIds, ['owner']); assert.deepEqual(round('2026-11-03').assigneeIds, ['member']);
    } finally { f.close(); }
  });
  test(`${platform} v2 assignment form shows the actual next date after a scheduled cadence change`, async () => {
    const f = await decisionFixture({ fixed: true });
    try {
      await f.a.actions.patchChoreConfiguration('floor', 1, { anchorDate: '2026-10-29', intervalDays: 3 }, '2026-10-29');
      const { screen } = await form(f, 'owner', platform);
      const choice = screen.nodes().find((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '次回から');
      await choice.props.onPress(); await screen.flush();
      assert.ok(screen.text().includes('適用する基準日：2026-10-29から'));
      await flag(screen, '担当：owner', true); await flag(screen, '担当：member', false); await screen.press('担当変更を保存');
      const op = (await f.owner.repository.readState()).assessment.view.ofType('assignmentRule').at(-1);
      assert.equal(op.payload.fromAnchorDate, '2026-10-29'); assert.equal(op.payload.ruleVersion, 2); assert.equal(op.payload.scope, 'from');
    } finally { f.close(); }
  });
  test(`${platform} v2 assignment scope seeds the next rounds assignees and never submits an untouched form`, async () => {
    const f = await decisionFixture({ fixed: true });
    try {
      await f.a.actions.assign(ref, ['owner'], 'next', false);
      const { screen } = await form(f, 'owner', platform);
      const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      const next = screen.nodes().find(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '次回から');
      await next.props.onPress(); await screen.flush();
      const switches = label => screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === label).props.value;
      assert.equal(switches('担当：owner'), true);
      assert.equal(switches('担当：member'), false);
      assert.equal(switches('管理者による固定担当にする'), false);
      assert.equal(screen.button('担当変更を保存').props.disabled, true);
      await screen.button('担当変更を保存').props.onPress();
      assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
      screen.unmount();
    } finally { f.close(); }
  });
  test(`${platform} v2 member assignment edits remain requests and the administrators explicit answer waits for its receipt`, async () => {
    const f = await decisionFixture({ fixed: true });
    try {
      await f.a.actions.assign(ref, ['member'], 'this', true); await f.deliver(f.owner);
      const member = await form(f, 'member', platform); await flag(member.screen, '担当：member', false);
      await member.screen.press('担当変更を申請'); assert.ok(member.screen.text().includes('元の担当を維持'));
      let model = await f.b.readModel(range); assert.equal(model.assignmentRequests[0].kind, 'pendingDelivery');
      assert.deepEqual(model.plan.occurrences.find((round) => round.id === member.props.round.id).assigneeIds, ['member']); await f.deliver(f.member);
      const owner = await requests(f, 'owner', platform); await owner.screen.press('担当変更を承認');
      assert.ok(owner.screen.text().includes('回答の送信待ち')); assert.equal((await f.a.readModel(range)).assignmentRequests[0].kind, 'awaiting');
      await f.deliver(f.owner); await owner.update(); await owner.screen.press('最新の担当申請を表示'); assert.ok(owner.screen.text().includes('承認済み'));
      model = await f.b.readModel(range); assert.deepEqual(model.plan.occurrences.find((round) => round.id === member.props.round.id).assigneeIds, []);
    } finally { f.close(); }
  });
  test(`${platform} v2 assignment save uses edits received before another render and preserves stale input after a conflicting change`, async () => {
    const f = await decisionFixture({ fixed: true });
    try {
      const { screen, update } = await form(f, 'owner', platform);
      const owner = screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === '担当：owner');
      const member = screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === '担当：member');
      owner.props.onValueChange(true); member.props.onValueChange(false);
      await f.a.actions.assign(ref, ['owner', 'member'], 'this', true);
      const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      await screen.button('担当変更を保存').props.onPress(); await screen.flush(); await update();
      assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before); assert.ok(screen.text().includes('入力は保持しています'));
      assert.equal(screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === '担当：owner').props.value, true);
      assert.equal(screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === '担当：member').props.value, false);
      assert.equal(screen.button('担当変更を保存').props.disabled, true);
    } finally { f.close(); }
  });
  test(`${platform} v2 formal resolution of simultaneous claims retains the actual worker and original assignees`, async () => {
    const f = await decisionFixture();
    try {
      await f.a.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: ref.anchorDate }, options: { strict: false, adminLocked: false } }); await f.deliver(f.owner);
      await f.a.actions.claim(ref); await f.b.actions.claim(ref); await f.deliver(f.owner); await f.deliver(f.member);
      await f.a.actions.complete(ref); const history = (await f.a.readModel(range)).plan.history;
      const { screen } = await form(f, 'owner', platform); await flag(screen, '担当：member', false);
      const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      await screen.press('担当変更を保存'); assert.ok(screen.text().includes('元の担当・競合と実施履歴を確認'));
      assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
      await flag(screen, '元の担当・競合と履歴への影響を確認した', true); await screen.press('担当変更を保存');
      const model = await f.a.readModel(range); assert.deepEqual(model.plan.history, history);
      const round = model.plan.occurrences.find((entry) => entry.anchorDate === ref.anchorDate && entry.choreId === 'floor');
      assert.equal(round.claimState, 'resolved'); assert.deepEqual(round.assigneeIds, ['owner']); assert.equal(round.completed, true);
      assert.deepEqual(history[0].originalAssigneeIds, ['member', 'owner']);
    } finally { f.close(); }
  });
  test(`${platform} v2 assignment remapping requires review of the old scope and atomically keeps its signed source`, async () => {
    const f = await decisionFixture({ fixed: true });
    try {
      const [old] = await f.a.actions.resolveAssignment({ ...ref, anchorDate: '2026-11-03' }, ['member'], 'once', true);
      await f.a.actions.configureChore('floor', { policy: chorePolicyFromPreset('common'), anchorDate: '2026-10-28', intervalDays: 4,
        windowBeforeDays: 2, windowAfterDays: 2, effectiveFrom: '2026-10-28', active: true }, { expectedRuleVersion: 1, preserveAssignments: false });
      const { screen } = await form(f, 'owner', platform, '2026-11-01');
      const previous = screen.button('担当変更を保存');
      const choice = screen.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === '2026-11-03の担当指定をこの回へ対応付ける');
      choice.props.onValueChange(true); const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      await previous.props.onPress(); await screen.flush(); assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
      assert.ok(screen.text().includes('元の担当・競合と実施履歴を確認')); assert.ok(screen.text().includes('2026-11-03の回を解除して対応付け'));
      await flag(screen, '担当：owner', true); await flag(screen, '元の担当・競合と履歴への影響を確認した', true); await screen.press('担当変更を保存');
      const state = await f.owner.repository.readState(); assert.ok(state.assessment.view.byId(old.operationId));
      assert.equal(state.assessment.view.ofType('assignmentCancel').length, 1);
      const model = await f.a.readModel(range); const target = model.plan.occurrences.find((entry) => entry.anchorDate === '2026-11-01' && entry.choreId === 'floor');
      assert.deepEqual(target.assigneeIds, ['owner']); assert.deepEqual(target.assignmentMappingReviewIds, []);
    } finally { f.close(); }
  });
  test(`${platform} v2 a member cannot submit another members assignment through the form`, async () => {
    const f = await decisionFixture({ fixed: true });
    try {
      await f.a.actions.assign(ref, ['owner'], 'this', true); await f.deliver(f.owner);
      const { screen } = await form(f, 'member', platform); assert.equal(screen.button('担当変更を申請').props.disabled, true);
      assert.equal((await f.member.repository.readState()).assessment.view.ofType('assignmentRequest').length, 0);
    } finally { f.close(); }
  });
  test(`${platform} v2 unnamed members have distinct assignment controls whose saved identities remain correct`, async () => {
    const f = await baseFixture({ fixed: true });
    try {
      const { screen } = await form(f, 'owner', platform); await flag(screen, '担当：メンバー（2）', true); await flag(screen, '担当：メンバー（1）', false);
      await screen.press('担当変更を保存');
      const op = (await f.owner.repository.readState()).assessment.view.ofType('assignmentRule').at(-1); assert.deepEqual(op.payload.memberIds, ['owner']);
    } finally { f.close(); }
  });
}
