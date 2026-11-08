import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { applyReceivedSharedFacts, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
import { receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { v2TargetFromForm, v2LocalTimeInput } from '../src/features/sharing/v2-ui/target-form.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
const ctrl = (d) => { let id = 0; return createV2GroupController(d.repository, { makeId: () => `${d.options.userId}-screen-${++id}`, now, sync: async () => {} }); };
async function card(d, platform, options = {}) {
  const controller = ctrl(d); let props;
  const update = async () => {
    const model = await controller.readModel(range); Object.assign(props, { model, round: model.plan.occurrences[0], subject: model.plan.occurrences[0].subjects[0] });
  };
  const model = await controller.readModel(range);
  props = { model, round: model.plan.occurrences[0], subject: model.plan.occurrences[0].subjects[0], actions: controller.actions, busy: false,
    showActions: true, run: async (work) => { await work(); await update(); }, onOpen: () => {}, onDate: () => {}, onPast: () => {}, onAssignment: () => {}, ...options };
  const screen = screenHarness('src/features/sharing/v2-ui/round-card.tsx', { exportName: 'V2RoundCard', platform, props });
  return { controller, props, screen };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} v2 shared card wires claim, completion and targeted undo into the isolated signed repository`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds()); const { screen, props } = await card(d, platform);
      await screen.press('担う'); assert.deepEqual(props.round.assigneeIds, ['owner']);
      const checkbox = () => screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox');
      await checkbox().props.onPress(); await screen.flush(); assert.equal(props.subject.completed, true); assert.equal(checkbox().props.accessibilityState.checked, true);
      assert.ok(screen.text().includes('実施者：'));
      await checkbox().props.onPress(); await screen.flush(); assert.equal(props.subject.completed, false); assert.equal(props.model.plan.history.length, 1); assert.equal(props.model.plan.history[0].active, false);
      await screen.press('担当を外す'); assert.deepEqual(props.round.assigneeIds, []);
      assert.equal(props.model.pendingChanges, 8);
    } finally { d.connection.close(); }
  });
  test(`${platform} v2 assigned cards omit claim controls and expose deliberate substitution without completing another person's task by checkbox`, async () => {
    const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
    try {
      await owner.repository.commit(seeds()); await ctrl(owner).actions.assign(ref, ['owner'], 'this', true);
      const facts = await loadSharedFacts(owner.database, groupId);
      await applyReceivedSharedFacts(member.database, groupId, facts, '5', member.repository.project, null, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(facts)));
      let substitution = 0; const { screen } = await card(member, platform, { onPast: () => { substitution++; } });
      assert.throws(() => screen.button('担う'), /missing button/);
      const checkbox = screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox'); assert.equal(checkbox.props.disabled, true);
      await screen.press('代行を記録'); assert.equal(substitution, 1); assert.equal((await member.repository.readState()).assessment.view.ofType('completion').length, 0);
    } finally { owner.connection.close(); member.connection.close(); }
  });
  test(`${platform} v2 compact cards keep secondary operations in details and show strict fulfillment separately from a real completion`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds()); const controller = ctrl(d);
      await controller.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' }, options: { strict: true } });
      await controller.actions.complete(ref);
      const { screen } = await card(d, platform, { showActions: false });
      assert.ok(screen.text().includes('指定日時の条件は未達成')); assert.equal(screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox').props.accessibilityState.checked, true);
      assert.throws(() => screen.button('日時を変更'), /missing button/); assert.throws(() => screen.button('以前の実施を記録'), /missing button/);
    } finally { d.connection.close(); }
  });
}
test('v2 date forms resolve local times in the shared timezone independently of the host OS and reject nonexistent times or invented intervals', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['Pacific/Honolulu', 'Asia/Tokyo', 'America/New_York']) {
      process.env.TZ = zone;
      assert.deepEqual(v2TargetFromForm({ mode: 'fixed', day: '2026-10-27', clock: '19:00', endDay: '2026-10-27', endClock: '19:30', timeZone: 'Asia/Tokyo' }),
        { precision: 'interval', start: '2026-10-27T10:00:00.000Z', end: '2026-10-27T10:30:00.000Z' });
      assert.throws(() => v2LocalTimeInput('2026-03-08', '02:30', 'America/New_York'), /存在しない/);
      assert.throws(() => v2TargetFromForm({ mode: 'fixed', day: '2026-10-27', clock: '19:00', endDay: '', endClock: '', timeZone: 'Asia/Tokyo' }));
    }
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 configuration editor automatically saves numeric edits and activation into the signed database without a save button`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds()); const controller = ctrl(d); const props = { model: await controller.readModel(range), choreId: 'floor', controller,
        onSaved: async () => { props.model = await controller.readModel(range); } };
      const screen = screenHarness('src/features/sharing/v2-ui/configuration-editor.tsx', { exportName: 'V2ConfigurationEditor', platform, props });
      await screen.change('共有家事の周期', '１７'); await screen.change('共有家事の基準日より後', '4'); await screen.endEditing('共有家事の周期');
      for (let i = 0; i < 20 && props.model.configurations[0].configuration.ruleVersion === 1; i++) await screen.flush();
      assert.equal(props.model.configurations[0].configuration.intervalDays, 17); assert.equal(props.model.configurations[0].configuration.windowAfterDays, 4);
      assert.equal(props.model.configurations[0].configuration.ruleVersion, 2); assert.throws(() => screen.button('個別設定を保存'), /missing button/);
      const toggle = screen.nodes().find(node => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === '共有家事を有効にする');
      assert.equal(toggle.props.accessibilityState.checked, true); assert.equal(toggle.props.disabled, false);
      toggle.props.onPress();
      for (let i = 0; i < 20 && props.model.configurations[0].configuration.active !== false; i++) await screen.flush();
      assert.equal(props.model.configurations[0].configuration.active, false); assert.equal(props.model.plan.chores[0].enabled, false);
      assert.equal((await controller.readModel(range)).configurations[0].configuration.intervalDays, 17);
    } finally { d.connection.close(); }
  });
  test(`${platform} v2 configuration editor keeps invalid input out of storage and flushes valid changes on background and navigation`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds()); const controller = ctrl(d); let stateListener; let focus; const effects = [];
      const props = { model: await controller.readModel(range), choreId: 'floor', controller, onSaved: async () => { props.model = await controller.readModel(range); } };
      const screen = screenHarness('src/features/sharing/v2-ui/configuration-editor.tsx', { exportName: 'V2ConfigurationEditor', platform, props,
        effect: (callback) => effects.push(callback), focusEffect: (callback) => { focus = callback; }, appStateListener: (callback) => { stateListener = callback; } });
      const cleanups = effects.splice(0).map((effect) => effect()); const leave = focus();
      await screen.change('共有家事の周期', '17'); await screen.change('共有家事の周期', ''); await screen.endEditing('共有家事の周期');
      assert.equal(props.model.configurations[0].configuration.ruleVersion, 1); assert.ok(screen.text().includes('1〜3650日の整数'));
      await screen.change('共有家事の周期', '9'); stateListener('background');
      for (let i = 0; i < 20 && props.model.configurations[0].configuration.intervalDays !== 9; i++) await screen.flush();
      assert.equal(props.model.configurations[0].configuration.intervalDays, 9);
      await screen.change('共有家事の基準日より前', '0'); leave();
      for (let i = 0; i < 20 && props.model.configurations[0].configuration.windowBeforeDays !== 0; i++) await screen.flush();
      assert.equal(props.model.configurations[0].configuration.windowBeforeDays, 0);
      for (const cleanup of cleanups) cleanup?.();
    } finally { d.connection.close(); }
  });
  test(`${platform} v2 settings guard native removal until saving succeeds and retain the draft after a failed back gesture`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds()); const controller = ctrl(d); let fail = true; let guard; let prevent = false; let repeated = 0;
      const save = controller.actions.patchChoreConfigurationFields; controller.actions.patchChoreConfigurationFields = async (...args) => { if (fail) throw new Error('SQLite full'); return save(...args); };
      const props = { model: await controller.readModel(range), choreId: 'floor', controller, onSaved: async () => { props.model = await controller.readModel(range); } };
      const screen = screenHarness('src/features/sharing/v2-ui/configuration-editor.tsx', { exportName: 'V2ConfigurationEditor', platform, props,
        preventRemove: (enabled, callback) => { prevent = enabled; guard = callback; } });
      await screen.change('共有家事の周期', '17'); assert.equal(prevent, true); guard({ repeat: () => { repeated++; } });
      for (let i = 0; i < 20 && !screen.text().includes('SQLite full'); i++) await screen.flush();
      assert.equal(repeated, 0); assert.equal(prevent, true); assert.equal(screen.nodes().find((node) => node.props.accessibilityLabel === '共有家事の周期').props.value, '17');
      fail = false; await screen.press('保存を再試行');
      for (let i = 0; i < 20 && props.model.configurations[0].configuration.intervalDays !== 17; i++) await screen.flush();
      assert.equal(props.model.configurations[0].configuration.intervalDays, 17); assert.equal(prevent, false); assert.equal(repeated, 0);
    } finally { d.connection.close(); }
  });
}

test('v2 a remote unresolved setting keeps the mounted input draft and prevents its queued write from choosing a conflict candidate', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const controller = ctrl(d); const effects = [];
    const props = { model: await controller.readModel(range), choreId: 'floor', controller, onSaved: async () => {} };
    const screen = screenHarness('src/features/sharing/v2-ui/configuration-editor.tsx', { exportName: 'V2ConfigurationEditor', props, effectDependencies: true, effect: (callback) => effects.push(callback) });
    effects.splice(0).forEach(effect => effect());
    await screen.change('共有家事の周期', '17');
    props.model = { ...props.model, configurations: props.model.configurations.map((entry) => ({ ...entry, configuration: null })) }; screen.render();
    effects.splice(0).forEach(effect => effect()); // React commits every changed effect; their ordinal is not part of the feature.
    const numeric = () => screen.nodes().find((node) => node.props.accessibilityLabel === '共有家事の周期');
    assert.equal(numeric().props.value, '17'); assert.equal(numeric().props.editable, false); assert.ok(screen.text().includes('入力は保持しています'));
    await screen.endEditing('共有家事の周期'); assert.equal((await controller.readModel(range)).configurations[0].configuration.intervalDays, 7);
    assert.equal(numeric().props.value, '17'); await screen.press('入力を最新の設定に戻す'); assert.equal(numeric().props.value, '7');
  } finally { d.connection.close(); }
});

test('v2 common cadence controls are absent for non-administrators and conflicting or unconfigured policies remain explicit', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const controller = ctrl(d); const model = await controller.readModel(range);
    const props = { model: { ...model, viewerUserId: 'member' }, choreId: 'floor', controller, onSaved: async () => {} };
    const screen = screenHarness('src/features/sharing/v2-ui/configuration-editor.tsx', { exportName: 'V2ConfigurationEditor', props });
    assert.equal(screen.nodes().some(node => node.type === 'Switch' || node.type === 'TextInput' || node.props.accessibilityRole === 'checkbox'), false); assert.ok(screen.text().includes('管理者'));
    props.model = { ...model, configurations: model.configurations.map((entry) => ({ ...entry, configuration: null })) }; screen.render();
    assert.ok(screen.text().includes('設定が競合')); assert.equal(screen.nodes().some((node) => node.type === 'TextInput'), false);
  } finally { d.connection.close(); }
});

for (const platform of ['ios', 'android']) {
  for (const embedded of [false, true]) test(`${platform} v2 fixed-assignee cards send a deliberate release request and the administrator's approval waits for its server receipt embedded=${embedded}`, async () => {
    const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
    try {
      await owner.repository.commit(seeds()); const controller = ctrl(owner); await controller.actions.assign(ref, ['member'], 'this', true);
      const receive = async (facts, cursor) => { for (const d of [owner, member]) {
        const old = await readSharingCheckpoint(d.database, groupId);
        await applyReceivedSharedFacts(d.database, groupId, facts, String(cursor), d.repository.project, old.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
      } };
      await receive(await loadSharedFacts(owner.database, groupId), 5);
      const memberCard = await card(member, platform); await memberCard.screen.press('自分の担当解除を申請');
      assert.equal(memberCard.props.model.assignmentRequests[0].kind, 'pendingDelivery'); assert.equal(memberCard.screen.button('担当変更を申請中').props.disabled, true);
      assert.deepEqual(memberCard.props.round.assigneeIds, ['member']);
      const req = (await loadSharedFacts(member.database, groupId)).find((fact) => fact.operation.entityType === 'assignmentRequest'); await receive([req], 6);
      const props = { model: await controller.readModel(range), actions: controller.actions, busy: false, embedded,
        run: async (work) => { await work(); props.model = await controller.readModel(range); } };
      const screen = screenHarness('src/features/sharing/v2-ui/assignment-requests.tsx', { exportName: 'V2AssignmentRequests', platform, props });
      await screen.press('担当変更を承認'); assert.ok(screen.text().includes('回答の送信待ち')); assert.equal(screen.button('担当変更を承認').props.disabled, true);
      assert.deepEqual(props.model.plan.occurrences[0].assigneeIds, ['member']);
      const answer = (await loadSharedFacts(owner.database, groupId)).find((fact) => fact.operation.entityType === 'assignmentDecision'); await receive([answer], 7);
      props.model = await controller.readModel(range); screen.render(); assert.ok(screen.text().includes('承認済み'));
      assert.deepEqual(props.model.plan.occurrences[0].assigneeIds, []); assert.equal(props.model.plan.planHash, (await memberCard.controller.readModel(range)).plan.planHash);
    } finally { owner.connection.close(); member.connection.close(); }
  });
  test(`${platform} v2 a stale checkbox cannot silently register substitution after another member became the assignee`, async () => {
    const f = await fixture(); const d = await f.device();
    try {
      await d.repository.commit(seeds()); const stale = await card(d, platform); await stale.controller.actions.assign(ref, ['member'], 'this', true);
      const checkbox = stale.screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox');
      await assert.rejects(checkbox.props.onPress(), { code: 'sharing/v2-stale-settings' });
      const current = await stale.controller.readModel(range); assert.equal(current.plan.history.length, 0); assert.deepEqual(current.plan.occurrences[0].assigneeIds, ['member']);
    } finally { d.connection.close(); }
  });
}

for (const platform of ['ios', 'android']) test(`${platform} compact shared rows omit redundant assignment and suggested-date text while claim stays independent from opening procedures`, async () => {
  const f = await fixture(); const d = await f.device(); let opened = 0;
  try {
    await d.repository.commit(seeds()); const { screen, props } = await card(d, platform, { showActions: false, home: true, onOpen: () => { opened++; } });
    assert.equal(screen.text().includes('全員共通'), false); assert.equal(screen.text().includes('担当未確定'), false);
    assert.equal(/(?:推奨日|基準日)：/u.test(screen.text()), false); assert.equal(screen.text().includes('引き受ける'), false);
    assert.equal(screen.button(`${props.model.plan.chores[0].name}の説明を開く`).props.accessibilityState, undefined);
    await screen.press('担う'); assert.deepEqual(props.round.assigneeIds, ['owner']); assert.equal(opened, 0);
    const pending = props.model.pendingChanges; await screen.press(`${props.model.plan.chores[0].name}の説明を開く`);
    assert.equal(opened, 1); assert.equal(props.model.pendingChanges, pending);
    assert.equal(props.subject.completed, false);
  } finally { d.connection.close(); }
});
