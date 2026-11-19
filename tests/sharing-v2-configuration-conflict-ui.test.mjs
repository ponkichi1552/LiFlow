import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice } from '../src/features/sharing/roster.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { applyReceivedSharedFacts, listSharingOutbox, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';

const range = { from: '2026-10-27', through: '2026-11-30', asOfDate: '2026-10-27' };
async function receive(d, facts) {
  const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
}
function controller(d) { let n = 0; return createV2GroupController(d.repository, { makeId: () => `configuration-${d.options.identity.deviceId}-${++n}`, now, sync: async () => {} }); }
async function setup() {
  const f = await fixture(); const secondIdentity = await createDeviceIdentity(sharingTestCrypto);
  f.archive.push(approveSharedDevice(f.archive.at(-1), f.owner, 'owner', secondIdentity));
  const a = await f.device(); const b = await f.device('owner', secondIdentity);
  const first = controller(a); const second = controller(b);
  await a.repository.commit(seeds());
  await first.actions.complete({ choreId: 'floor', anchorDate: '2026-10-27', subjectUserId: null });
  await first.actions.assign({ choreId: 'floor', anchorDate: '2026-11-03', subjectUserId: null }, ['member'], 'this', true);
  await receive(b, await loadSharedFacts(a.database, groupId));
  const configuration = (await first.readModel(range)).configurations[0].configuration;
  await first.actions.configureChore('floor', { ...configuration, intervalDays: 14, effectiveFrom: '2026-10-28' }, { expectedRuleVersion: 1, preserveAssignments: false });
  await second.actions.configureChore('floor', { ...configuration, intervalDays: 10, effectiveFrom: '2026-10-28' }, { expectedRuleVersion: 1, preserveAssignments: false });
  const union = [...new Map([...(await loadSharedFacts(a.database, groupId)), ...(await loadSharedFacts(b.database, groupId))].map(fact => [fact.operation.operationId, fact])).values()];
  await receive(a, union); await receive(b, union);
  return { f, a, b, first, second, close: () => { a.connection.close(); b.connection.close(); } };
}
async function open(f, platform, options = {}) {
  let backs = 0; const props = { model: await f.first.readModel(range), choreId: 'floor', controller: f.first, onBack: () => { backs++; },
    onSaved: async () => { props.model = await f.first.readModel(range); }, ...options };
  const screen = screenHarness('src/features/sharing/v2-ui/configuration-editor.tsx', { exportName: 'V2ConfigurationEditor', platform, props });
  const settle = async (predicate) => { for (let n = 0; n < 35 && !predicate(); n++) await screen.flush(); assert.ok(predicate(), screen.text()); };
  return { props, screen, settle, backs: () => backs };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} configuration conflicts show the actual rotation order and switching condition before confirming a candidate`, async t => {
    const f = await setup(); t.after(f.close);
    const savedModel = await f.first.readModel(range);
    const labels = new Map([['owner', '葵'], ['member', '光']]);
    const model = { ...savedModel, plan: { ...savedModel.plan,
      members: savedModel.plan.members.map(member => ({ ...member, displayName: labels.get(member.userId) ?? member.displayName })) } };
    const original = model.configurations[0];
    const sequences = [['member', 'owner', 'member'], ['owner', 'member']];
    const candidates = original.candidates.map((candidate, index) => ({ ...candidate, configuration: { ...candidate.configuration,
      policy: { ...candidate.configuration.policy, assignment: { mode: 'selected', memberIds: ['member', 'owner'],
        rotation: { sequence: sequences[index], advanceOn: index === 0 ? 'completion' : 'occurrence' } } } } }));
    const saved = [];
    const ui = screenHarness('src/features/sharing/v2-ui/configuration-conflict.tsx', { exportName: 'V2ConfigurationConflict', platform,
      props: { model, row: { ...original, candidates }, controller: { actions: { configureChore: async (_id, value) => { saved.push(value.policy.assignment.rotation); } } }, onSaved: async () => {} } });
    t.after(() => ui.unmount());
    await ui.press('設定候補1を開く');
    assert.match(ui.text(), /光 → 葵 → 光/u);
    assert.match(ui.text(), /完了したら交代/u);
    await ui.press('設定候補2を開く');
    assert.match(ui.text(), /葵 → 光/u);
    assert.match(ui.text(), /予定ごとに交代/u);
    await ui.press('設定候補2で解決する');
    assert.deepEqual(saved, [{ sequence: sequences[1], advanceOn: 'occurrence' }]);
  });

  test(`${platform} shared configuration conflicts show explicit candidates and resolve the current selection without rewriting completed history`, async () => {
    const f = await setup();
    try {
      const ui = await open(f, platform); const row = ui.props.model.configurations[0]; const history = ui.props.model.plan.history;
      assert.equal(row.configuration, null); assert.equal(row.candidates.length, 2); const before = await listSharingOutbox(f.a.database, groupId);
      assert.ok(ui.screen.button('戻る')); assert.throws(() => ui.screen.button('設定候補1で解決する'), /missing button/u);
      await ui.screen.press('設定候補1を開く'); assert.match(ui.screen.text(), /担当.*付け替え/u);
      const date = ui.screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '競合解決の適用開始日');
      assert.equal(date.props.value, '2026-10-28'); assert.deepEqual(await listSharingOutbox(f.a.database, groupId), before);
      const button = ui.screen.button('設定候補1で解決する'); button.props.onPress(); button.props.onPress();
      await ui.settle(() => ui.props.model.configurations[0].configuration !== null);
      const selected = ui.props.model.configurations[0].configuration;
      assert.equal(selected.ruleVersion, 3); assert.equal(selected.intervalDays, row.candidates[0].configuration.intervalDays);
      assert.equal(selected.effectiveFrom, '2026-10-28'); assert.deepEqual(ui.props.model.plan.history, history);
      assert.equal((await listSharingOutbox(f.a.database, groupId)).length, before.length + 2);
      await receive(f.b, await loadSharedFacts(f.a.database, groupId));
      await receive(f.a, await loadSharedFacts(f.b.database, groupId));
      assert.equal((await f.second.readModel(range)).plan.planHash, (await f.first.readModel(range)).plan.planHash);
    } finally { f.close(); }
  });

  test(`${platform} an old configuration-resolution button cannot replace a newer resolution received before repaint`, async () => {
    const f = await setup();
    try {
      const ui = await open(f, platform); const row = ui.props.model.configurations[0]; await ui.screen.press('設定候補1を開く');
      const oldButton = ui.screen.button('設定候補1で解決する');
      await f.second.actions.configureChore('floor', { ...row.candidates[1].configuration, effectiveFrom: '2026-10-28' },
        { expectedRuleVersion: row.revision, resolveConfigurationIds: row.candidates.map(candidate => candidate.operationId), preserveAssignments: false });
      await receive(f.a, await loadSharedFacts(f.b.database, groupId)); const before = await listSharingOutbox(f.a.database, groupId);
      oldButton.props.onPress(); await ui.settle(() => ui.screen.text().includes('別の変更が届いています'));
      assert.deepEqual(await listSharingOutbox(f.a.database, groupId), before);
      assert.equal((await f.first.readModel(range)).configurations[0].configuration.intervalDays, row.candidates[1].configuration.intervalDays);
    } finally { f.close(); }
  });

  test(`${platform} ordinary members can return from conflicting common settings without receiving resolution controls`, async () => {
    const f = await setup(); const member = await f.f.device('member', f.f.member);
    try {
      await receive(member, await loadSharedFacts(f.a.database, groupId)); const c = controller(member); let backs = 0;
      const props = { model: await c.readModel(range), choreId: 'floor', controller: c, onBack: () => { backs++; }, onSaved: async () => {} };
      const screen = screenHarness('src/features/sharing/v2-ui/configuration-editor.tsx', { exportName: 'V2ConfigurationEditor', platform, props });
      assert.match(screen.text(), /管理者/u); assert.throws(() => screen.button('設定候補1を開く'), /missing button/u);
      await screen.press('戻る'); assert.equal(backs, 1);
    } finally { member.connection.close(); f.close(); }
  });
}
