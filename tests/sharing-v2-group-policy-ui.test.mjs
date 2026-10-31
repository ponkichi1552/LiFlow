import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice } from '../src/features/sharing/roster.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { applyReceivedSharedFacts, listSharingOutbox, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';

const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const ids = field => field.candidates.map(candidate => candidate.operationId);
function controller(d) { let n = 0; return createV2GroupController(d.repository, { makeId: () => `group-policy-${d.options.identity.deviceId}-${++n}`, now, sync: async () => {} }); }
async function receive(d, facts) { const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts))); }
async function setup() {
  const f = await fixture(); const d = await f.device(); const initial = seeds();
  Object.assign(initial[0].payload.configuration, { delegationEnabled: false, allowBeforeWindow: false, completionPushEnabled: true });
  await d.repository.commit(initial); return { f, d, c: controller(d), close: () => d.connection.close() };
}
async function open(c, platform) {
  const effects = []; const cleanups = []; let focus; let backs = 0;
  const props = { model: await c.readModel(range, { groupPolicy: true }), controller: c, onSaved: async () => { props.model = await c.readModel(range, { groupPolicy: true }); }, onBack: () => { backs++; } };
  const screen = screenHarness('src/features/sharing/v2-ui/group-policy-editor.tsx', { exportName: 'V2GroupPolicyEditor', platform, props,
    effect: callback => effects.push(callback), focusEffect: callback => { focus = callback; } });
  const commit = () => { for (const effect of effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup); } };
  const settle = async predicate => { for (let n = 0; n < 35; n++) { commit(); await screen.flush(); if (!predicate || predicate()) return; } assert.fail(screen.text()); };
  const leave = focus?.(); await settle();
  return { props, screen, commit, settle, backs: () => backs, close: async () => {
    if (screen.text().includes('入力を最新のルールに戻す')) await screen.press('入力を最新のルールに戻す');
    leave?.(); for (const cleanup of cleanups) cleanup(); await screen.flush();
  } };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} completion notifications expose an opt-in switch and autosave without changing other group rules`, async () => {
    const f = await setup(); await f.c.actions.patchGroupPolicy({ completionPushEnabled: false }); const ui = await open(f.c, platform);
    try {
      const before = ui.props.model.groupPolicy.value; await ui.screen.press('担当と完了状況を開く');
      const flag = ui.screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === 'メンバーの完了を通知');
      assert.ok(flag); assert.equal(flag.props.value, false); assert.match(ui.screen.text(), /同期で受信した完了/u);
      flag.props.onValueChange(true); await ui.screen.flush(); await ui.screen.press('戻る'); await ui.settle(() => ui.backs() === 1);
      assert.deepEqual((await f.c.readModel(range, { groupPolicy: true })).groupPolicy.value, { ...before, completionPushEnabled: true });
    } finally { await ui.close(); f.close(); }
  });
  test(`${platform} the shared screen immediately displays the authenticated offline group name instead of a stale registry label`, async () => {
    const f = await setup(); let leave;
    try {
      const original = await f.c.readModel(range, { groupPolicy: true }); await f.c.actions.editGroupOptions([{ field: 'name', value: '端末に保存した新しい名前', basisOperationIds: ids(original.groupSettings.name) }]);
      let focus; const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
        props: { purpose: 'workspace', view: 'home', workspaceName: '古いキャッシュ名', loadSession: async () => createV2ScreenSession({ controller: f.c, groupId, userId: 'owner', now, readPreferences: () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) }),
          onBack() {}, onHistory() {}, onConfiguration() {} }, focusEffect: callback => { focus = callback; } });
      leave = focus(); for (let n = 0; n < 25 && !screen.text().includes('端末に保存した新しい名前'); n++) await screen.flush();
      assert.ok(screen.text().includes('端末に保存した新しい名前')); assert.ok(!screen.text().includes('古いキャッシュ名'));
    } finally { leave?.(); f.close(); }
  });

  test(`${platform} group name and region share one autosave queue and timezone search alone never changes shared settings`, async () => {
    const f = await setup(); const ui = await open(f.c, platform);
    try {
      const before = await listSharingOutbox(f.d.database, groupId); assert.equal((await f.c.readModel(range)).groupSettings, undefined);
      await ui.screen.press('グループ名と地域を開く'); await ui.screen.change('地域を検索', 'ニューヨーク');
      assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
      await ui.screen.change('グループ名', '  家族の家事  ');
      const choice = ui.screen.nodes().find(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === 'ニューヨーク（America/New_York）');
      assert.ok(choice); choice.props.onPress(); await ui.screen.flush(); await ui.screen.press('戻る'); await ui.settle(() => ui.backs() === 1);
      const after = await f.c.readModel(range, { groupPolicy: true }); assert.equal(after.plan.commonSettings.name, '家族の家事'); assert.equal(after.plan.timeZone, 'America/New_York');
      assert.equal(after.configurations[0].configuration.intervalDays, 7); assert.equal(after.plan.history.length, 0);
      const edits = (await listSharingOutbox(f.d.database, groupId)).slice(before.length); assert.equal(edits.length, 1); assert.equal(edits[0].operation.entityType, 'settings');
      assert.ok(ui.screen.text().includes('既存の指定・申請は元の地域を維持'));
    } finally { await ui.close(); f.close(); }
  });

  test(`${platform} invalid group names keep the settings draft and prevent navigation without silently saving an empty name`, async () => {
    const f = await setup(); const ui = await open(f.c, platform);
    try {
      const before = await listSharingOutbox(f.d.database, groupId); await ui.screen.press('グループ名と地域を開く'); await ui.screen.change('グループ名', '   ');
      await ui.screen.press('戻る'); await ui.settle(() => ui.screen.text().includes('グループ名は1〜500文字'));
      assert.equal(ui.backs(), 0); assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
      await ui.screen.press('入力を最新のルールに戻す'); await ui.settle(); await ui.screen.press('戻る'); assert.equal(ui.backs(), 1);
    } finally { await ui.close(); f.close(); }
  });

  test(`${platform} group timezone conflicts remain repairable through the real management read and require every current signed candidate`, async () => {
    const f = await setup(); const identity = await createDeviceIdentity(sharingTestCrypto);
    f.f.archive.push(approveSharedDevice(f.f.archive.at(-1), f.f.owner, 'owner', identity)); const other = await f.f.device('owner', identity); let ui;
    try {
      await receive(other, await loadSharedFacts(f.d.database, groupId)); const second = controller(other);
      const original = (await f.c.readModel(range, { groupPolicy: true })).groupSettings.timeZone;
      await f.c.actions.editGroupOptions([{ field: 'timeZone', value: 'America/New_York', basisOperationIds: ids(original) }]);
      await second.actions.editGroupOptions([{ field: 'timeZone', value: 'Europe/London', basisOperationIds: ids(original) }]);
      await receive(f.d, await loadSharedFacts(other.database, groupId));
      const repair = await f.c.readModel(({ timeZone }) => { assert.equal(timeZone, 'UTC'); return range; }, { groupPolicy: true });
      assert.equal(repair.plan.initialized, false); assert.equal(repair.groupSettings.timeZone.kind, 'conflict');
      await assert.rejects(f.c.readModel(() => range), { code: 'sharing/v2-history-conflict' });
      ui = await open(f.c, platform); await ui.screen.press('グループ名と地域を開く');
      assert.ok(ui.screen.text().includes('地域が競合しています')); assert.equal(ui.screen.nodes().some(node => node.props.accessibilityLabel === '地域を検索'), false);
      const sources = repair.groupSettings.timeZone; const before = await listSharingOutbox(f.d.database, groupId);
      await assert.rejects(f.c.actions.editGroupOptions([{ field: 'timeZone', value: sources.candidates[0].value,
        basisOperationIds: ids(sources), resolveOperationIds: ids(sources).slice(0, 1) }]));
      assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
      await ui.screen.press('地域の候補1で解決する'); await ui.screen.press('戻る'); await ui.settle(() => ui.backs() === 1);
      const after = await f.c.readModel(range, { groupPolicy: true }); assert.equal(after.plan.initialized, true);
      assert.equal(after.plan.timeZone, sources.candidates[0].value); assert.equal(after.configurations[0].configuration.intervalDays, 7);
      await receive(other, await loadSharedFacts(f.d.database, groupId)); await receive(f.d, await loadSharedFacts(other.database, groupId));
      assert.equal((await second.readModel(range)).plan.planHash, (await f.c.readModel(range)).plan.planHash);
    } finally { await ui?.close(); other.connection.close(); f.close(); }
  });

  test(`${platform} group kind and rule changes autosave together without resetting customized flags or granting anyone rights`, async () => {
    const f = await setup(); const ui = await open(f.c, platform);
    try {
      const before = await listSharingOutbox(f.d.database, groupId); const original = ui.props.model.groupPolicy.value;
      assert.equal((await f.c.readModel(range)).groupPolicy, undefined);
      await ui.screen.press('日時変更のルールを開く');
      const switchNode = ui.screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === '担当者の期間後への変更を許可');
      const kind = ui.screen.nodes().find(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '同居人');
      kind.props.onPress(); switchNode.props.onValueChange(true); await ui.screen.flush(); await ui.screen.press('戻る');
      await ui.settle(() => ui.backs() === 1);
      const next = (await f.c.readModel(range, { groupPolicy: true })).groupPolicy.value;
      assert.deepEqual(next, { ...original, kind: 'roommates', allowAfterWindow: true });
      assert.equal((await listSharingOutbox(f.d.database, groupId)).length, before.length + 1);
      assert.equal((await f.d.repository.readState()).assessment.view.ofType('datePermission').length, 0);
      assert.deepEqual(ui.props.model.plan.history, []); assert.equal(ui.props.model.configurations[0].configuration.intervalDays, 7);
    } finally { await ui.close(); f.close(); }
  });

  test(`${platform} group rule edits reject an unseen concurrent change and retain the draft until it is discarded`, async () => {
    const f = await setup(); const ui = await open(f.c, platform);
    try {
      await ui.screen.press('日時変更のルールを開く'); const old = ui.screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === '前倒しの変更を自動承認');
      await f.c.actions.patchGroupPolicy({ allowSubstitution: false });
      ui.props.model = await f.c.readModel(range, { groupPolicy: true }); ui.screen.render(); ui.commit();
      old.props.onValueChange(false); await ui.screen.press('戻る'); await ui.settle(() => ui.screen.text().includes('別の変更が届いています'));
      assert.equal(ui.backs(), 0); const current = (await f.c.readModel(range, { groupPolicy: true })).groupPolicy.value;
      assert.equal(current.autoApproveEarlier, true); assert.equal(current.allowSubstitution, false);
      await ui.screen.press('入力を最新のルールに戻す'); await ui.settle();
      const restored = ui.screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === '前倒しの変更を自動承認'); assert.equal(restored.props.value, true);
    } finally { await ui.close(); f.close(); }
  });

  test(`${platform} group rule conflicts retain authenticated candidates and need an explicit current resolution`, async () => {
    const f = await setup(); const secondIdentity = await createDeviceIdentity(sharingTestCrypto);
    f.f.archive.push(approveSharedDevice(f.f.archive.at(-1), f.f.owner, 'owner', secondIdentity));
    const other = await f.f.device('owner', secondIdentity); let ui;
    try {
      await receive(other, await loadSharedFacts(f.d.database, groupId)); const second = controller(other);
      const source = (await f.c.readModel(range, { groupPolicy: true })).groupPolicy;
      await f.c.actions.editGroupPolicy({ value: { ...source.value, allowBeforeWindow: true }, basisOperationIds: ids(source) });
      await second.actions.editGroupPolicy({ value: { ...source.value, allowSubstitution: false }, basisOperationIds: ids(source) });
      await receive(f.d, await loadSharedFacts(other.database, groupId)); ui = await open(f.c, platform);
      const conflict = ui.props.model.groupPolicy; assert.equal(conflict.kind, 'conflict'); assert.equal(ui.props.model.plan.policy, null);
      assert.throws(() => ui.screen.button('ルール候補1で解決する'), /missing button/u);
      const candidate = ui.screen.nodes().find(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.startsWith('ルール候補1 · '));
      await candidate.props.onPress(); await ui.screen.flush(); await ui.screen.press('ルール候補1で解決する');
      await ui.settle(() => ui.props.model.groupPolicy.kind === 'value');
      assert.deepEqual(ui.props.model.groupPolicy.value, conflict.candidates[0].value);
      await receive(other, await loadSharedFacts(f.d.database, groupId)); await receive(f.d, await loadSharedFacts(other.database, groupId));
      assert.equal((await second.readModel(range)).plan.planHash, (await f.c.readModel(range)).plan.planHash);
    } finally { await ui?.close(); other.connection.close(); f.close(); }
  });

  test(`${platform} ordinary members can read group rules but cannot mutate them through UI or the command API`, async () => {
    const f = await setup(); const member = await f.f.device('member', f.f.member); let ui;
    try {
      await receive(member, await loadSharedFacts(f.d.database, groupId)); const c = controller(member); ui = await open(c, platform);
      assert.match(ui.screen.text(), /管理者が変更/u); assert.equal(ui.screen.nodes().some(node => node.type === 'Switch' || node.props.accessibilityRole === 'radio'), false);
      const before = await listSharingOutbox(member.database, groupId); const source = ui.props.model.groupPolicy;
      await assert.rejects(c.actions.editGroupPolicy({ value: { ...source.value, allowBeforeWindow: true }, basisOperationIds: ids(source) }), { code: 'sharing/v2-authority-denied' });
      assert.deepEqual(await listSharingOutbox(member.database, groupId), before);
      await ui.screen.press('戻る'); assert.equal(ui.backs(), 1);
    } finally { await ui?.close(); member.connection.close(); f.close(); }
  });
}

test('group option edits atomically merge independent settings fields and preserve configuration when another administrator changed a different field', async () => {
  const f = await setup();
  try {
    const original = await f.c.readModel(range, { groupPolicy: true });
    await f.c.actions.editGroupOptions([{ field: 'name', value: '新しい名前', basisOperationIds: ids(original.groupSettings.name) }]);
    await f.c.actions.editGroupOptions([{ field: 'timeZone', value: 'America/New_York', basisOperationIds: ids(original.groupSettings.timeZone) }]);
    const after = await f.c.readModel(range, { groupPolicy: true }); assert.equal(after.plan.commonSettings.name, '新しい名前'); assert.equal(after.plan.timeZone, 'America/New_York');
    const before = await listSharingOutbox(f.d.database, groupId);
    await assert.rejects(f.c.actions.editGroupOptions([{ field: 'name', value: '別名', basisOperationIds: ids(original.groupSettings.name) }]));
    await assert.rejects(f.c.actions.editGroupOptions([{ field: 'name', value: '戻す', basisOperationIds: ids(after.groupSettings.name) },
      { field: 'configuration', value: { ...after.groupPolicy.value, kind: 'unknown' }, basisOperationIds: ids(after.groupPolicy) }]));
    assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
    assert.deepEqual((await f.c.readModel(range)).plan.commonSettings, after.plan.commonSettings);
  } finally { f.close(); }
});

test('group name and region settings remain administrator-only and a caller cannot smuggle non-settings fields into the editor command', async () => {
  const f = await setup(); const member = await f.f.device('member', f.f.member);
  try {
    await receive(member, await loadSharedFacts(f.d.database, groupId)); const c = controller(member); const model = await c.readModel(range, { groupPolicy: true });
    const before = await listSharingOutbox(member.database, groupId);
    await assert.rejects(c.actions.editGroupOptions([{ field: 'name', value: '不許可の編集', basisOperationIds: ids(model.groupSettings.name) }]), { code: 'sharing/v2-authority-denied' });
    await assert.rejects(f.c.actions.editGroupOptions([{ field: 'anchorDate', value: '2026-10-28', basisOperationIds: [] }]));
    assert.deepEqual(await listSharingOutbox(member.database, groupId), before);
  } finally { member.connection.close(); f.close(); }
});

test('group options save policy and identity changes in the same SQLite transaction and exact no-op retries enqueue no extra operation', async () => {
  const f = await setup();
  try {
    const model = await f.c.readModel(range, { groupPolicy: true }); const before = await listSharingOutbox(f.d.database, groupId);
    const edits = [{ field: 'name', value: '共同生活', basisOperationIds: ids(model.groupSettings.name) },
      { field: 'configuration', value: { ...model.groupPolicy.value, kind: 'roommates' }, basisOperationIds: ids(model.groupPolicy) }];
    const result = await f.c.actions.editGroupOptions(edits); assert.equal(result.operations.length, 2);
    assert.equal((await listSharingOutbox(f.d.database, groupId)).length, before.length + 2);
    assert.equal(result.fields.name.value, '共同生活'); assert.equal(result.fields.configuration.value.kind, 'roommates');
    const retry = await f.c.actions.editGroupOptions(edits); assert.equal(retry.operations.length, 0);
    assert.equal((await listSharingOutbox(f.d.database, groupId)).length, before.length + 2);
  } finally { f.close(); }
});
