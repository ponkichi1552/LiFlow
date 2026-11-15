import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice, removeSharedMembers } from '../src/features/sharing/roster.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { v2MemberLabels } from '../src/features/sharing/v2-ui/member-labels.ts';
import { applyReceivedSharedFacts, listSharingOutbox, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const source = c => c.readModel(range, { permissionsChoreId: 'floor' });
const ids = field => field.candidates.map(candidate => candidate.operationId);
async function setup() {
  const f = await fixture(); const d = await f.device(); const initial = seeds();
  initial.push({ operationId: 'owner-profile', entityType: 'member', entityId: 'owner', operationType: 'patch', payload: { displayName: '管理者' } });
  await d.repository.commit(initial); let n = 0; const c = createV2GroupController(d.repository, { makeId: () => `rights-ui-${++n}`, now, sync: async () => {} });
  return { f, d, c, close: () => d.connection.close() };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function open(c, platform) {
  const effects = []; const cleanups = []; const pending = new Set(); let focus; let backs = 0; let appState;
  const track = async work => { const promise = work(); pending.add(promise); try { return await promise; } finally { pending.delete(promise); } };
  const controller = { ...c, actions: { ...c.actions, editDateRights: (...args) => track(() => c.actions.editDateRights(...args)) } };
  const props = { model: await source(c), choreId: 'floor', controller, onBack: () => { backs++; }, onSaved: () => track(async () => { props.model = await source(c); }) };
  const screen = screenHarness('src/features/sharing/v2-ui/date-rights-editor.tsx', { exportName: 'V2DateRightsEditor', platform, props,
    effect: callback => effects.push(callback), focusEffect: callback => { focus = callback; }, appStateListener: listener => { appState = listener; } });
  const commit = () => { for (const effect of effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup); } };
  const settle = async predicate => { for (let n = 0; n < 40; n++) { commit(); await screen.flush(); if (!predicate || predicate()) return; } assert.fail(screen.text()); };
  const leave = focus?.(); await settle();
  return { props, screen, commit, settle, flushPending: () => appState?.('background'), backs: () => backs, nameOf: id => v2MemberLabels(props.model.plan.members)(id),
    close: async () => {
      // Departure is immediate in the app; let its retained writer finish before closing SQLite.
      while (pending.size) { await Promise.allSettled([...pending]); await screen.flush(); }
      await settle();
      if (!backs && screen.text().includes('入力を最新の権限に戻す')) await screen.press('入力を最新の権限に戻す');
      leave?.(); for (const cleanup of cleanups) cleanup(); await screen.flush();
    } };
}
const control = (ui, label) => { const node = ui.screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === label); assert.ok(node, label); return node; };
async function expand(ui, userId = 'member') { await ui.screen.press(`${ui.nameOf(userId)}の権限を開く`); await ui.settle(); }

for (const platform of ['ios', 'android']) {
  test(`${platform} per-chore rights are collapsed and explicitly autosave only that member and chore`, async () => {
    const f = await setup(); const ui = await open(f.c, platform);
    try {
      const before = await listSharingOutbox(f.d.database, groupId); assert.equal(ui.screen.nodes().some(node => node.type === 'Switch'), false);
      await expand(ui); const name = ui.nameOf('member'); control(ui, `${name}への権限を有効にする`).props.onValueChange(true); await ui.settle();
      control(ui, `${name}：日時を指定できる`).props.onValueChange(true); await ui.settle();
      control(ui, `${name}：他の担当者の日時も変更できる`).props.onValueChange(true);
      control(ui, `${name}：期間前への変更ができる`).props.onValueChange(true); await ui.screen.press('戻る'); await ui.settle(() => ui.backs() === 1);
      const value = (await source(f.c)).dateRights.fields.member.value;
      assert.deepEqual(value, { enabled: true, rights: { changeDate: true, changeOthers: true, changeBeforeWindow: true } });
      const facts = (await f.d.repository.readState()).assessment.view.ofType('datePermission'); assert.equal(facts.length, 1);
      assert.equal(facts[0].payload.choreId, 'floor'); assert.equal(facts[0].payload.userId, 'member');
      assert.equal((await listSharingOutbox(f.d.database, groupId)).length, before.length + 1);
    } finally { await ui.close(); f.close(); }
  });

  test(`${platform} disabled group delegation blocks new grants but still permits a member's explicit revocation`, async () => {
    const f = await setup(); let ui;
    try {
      const original = await source(f.c); await f.c.actions.editDateRights('floor', [{ userId: 'member', expectedMembershipStart: 2, value: { enabled: true,
        rights: { changeDate: true, changeOthers: true, changeBeforeWindow: true } }, basisOperationIds: [] }], ids(original.groupPolicy));
      await f.c.actions.patchGroupPolicy({ delegationEnabled: false }); ui = await open(f.c, platform); await expand(ui); const name = ui.nameOf('member');
      assert.match(ui.screen.text(), /委譲機能はOFF/u); assert.equal(control(ui, `${name}：日時を指定できる`).props.disabled, true);
      control(ui, `${name}への権限を有効にする`).props.onValueChange(false); await ui.screen.press('戻る'); await ui.settle(() => ui.backs() === 1);
      assert.equal((await source(f.c)).dateRights.fields.member.value.enabled, false);
      await f.c.actions.patchGroupPolicy({ delegationEnabled: true }); assert.equal((await source(f.c)).dateRights.fields.member.value.enabled, false);
    } finally { await ui?.close(); f.close(); }
  });

  test(`${platform} a permission event from before repaint keeps its displayed group-rule basis instead of using an unseen update`, async () => {
    const f = await setup(); const ui = await open(f.c, platform);
    try {
      await expand(ui); const old = control(ui, `${ui.nameOf('member')}への権限を有効にする`);
      await f.c.actions.patchGroupPolicy({ allowSubstitution: false }); const before = await listSharingOutbox(f.d.database, groupId);
      ui.props.model = await source(f.c); ui.screen.render(); ui.commit(); old.props.onValueChange(true);
      ui.flushPending(); await ui.settle(() => ui.screen.text().includes('別の変更が届いています'));
      assert.equal(ui.backs(), 0); assert.equal((await source(f.c)).dateRights.fields.member.kind, 'missing');
      assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
    } finally { await ui.close(); f.close(); }
  });

  test(`${platform} a removed member's in-flight permission draft remains inspectable and discardable without granting rights`, async () => {
    const f = await setup(); const entered = deferred(); const release = deferred(); let ui;
    const delayed = { ...f.c, actions: { ...f.c.actions, editDateRights: async (...args) => { entered.resolve(); await release.promise; return f.c.actions.editDateRights(...args); } } };
    try {
      ui = await open(delayed, platform); await expand(ui); const before = await listSharingOutbox(f.d.database, groupId);
      control(ui, `${ui.nameOf('member')}への権限を有効にする`).props.onValueChange(true); ui.flushPending(); await entered.promise;
      f.f.archive.push(removeSharedMembers(f.f.archive.at(-1), f.f.owner, ['member']));
      ui.props.model = await source(f.c); ui.screen.render(); await ui.settle(); release.resolve();
      await ui.settle(() => ui.screen.text().includes('別の変更が届いています')); assert.match(ui.screen.text(), /参加状態が変わった/u);
      assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before); assert.equal(ui.backs(), 0);
      await ui.screen.press('入力を最新の権限に戻す'); await ui.settle(); await ui.screen.press('戻る'); await ui.settle(() => ui.backs() === 1);
      assert.equal((await f.d.repository.readState()).assessment.view.ofType('datePermission').length, 0);
    } finally { release.resolve(); await ui?.close(); f.close(); }
  });

  test(`${platform} a newly approved member can be edited while another member saves without replacing the first draft`, async () => {
    const f = await setup(); const identity = await createDeviceIdentity(sharingTestCrypto); const entered = deferred(); const release = deferred(); let ui;
    const addedEntered = deferred(); const addedRelease = deferred(); const addedSaved = deferred();
    const delayed = { ...f.c, actions: { ...f.c.actions, editDateRights: async (...args) => {
      entered.resolve(); await release.promise;
      const includesAdded = args[1].some(edit => edit.userId === 'new-member');
      if (includesAdded) { addedEntered.resolve(); await addedRelease.promise; }
      const result = await f.c.actions.editDateRights(...args);
      if (includesAdded) addedSaved.resolve();
      return result;
    } } };
    try {
      ui = await open(delayed, platform); await expand(ui);
      control(ui, `${ui.nameOf('member')}への権限を有効にする`).props.onValueChange(true); await entered.promise;
      f.f.archive.push(approveSharedDevice(f.f.archive.at(-1), f.f.owner, 'new-member', identity));
      ui.props.model = await source(f.c); ui.screen.render(); await ui.settle(); await expand(ui, 'new-member');
      const added = control(ui, `${ui.nameOf('new-member')}への権限を有効にする`); assert.equal(added.props.disabled, false);
      added.props.onValueChange(true); release.resolve(); await ui.screen.press('戻る');
      await ui.settle(() => ui.backs() === 1); await addedEntered.promise;
      assert.equal(ui.backs(), 1, 'navigation must finish while the accepted second save is still pending');
      addedRelease.resolve(); await addedSaved.promise;
      const fields = (await source(f.c)).dateRights.fields;
      assert.equal(fields.member.value.enabled, true); assert.equal(fields['new-member'].value.enabled, true);
      assert.equal((await f.d.repository.readState()).assessment.view.ofType('datePermission').length, 2);
    } finally { release.resolve(); addedRelease.resolve(); await ui?.close(); f.close(); }
  });

  test(`${platform} a non-administrator permission route exposes a return action and no editing controls`, async () => {
    const f = await setup(); const member = await f.f.device('member', f.f.member); let ui;
    try {
      const facts = await loadSharedFacts(f.d.database, groupId); const checkpoint = await readSharingCheckpoint(member.database, groupId);
      await applyReceivedSharedFacts(member.database, groupId, facts, String(facts.length), member.repository.project, checkpoint.cursor, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(facts)));
      const c = createV2GroupController(member.repository, { makeId: () => 'forbidden-grant', now, sync: async () => {} }); ui = await open(c, platform);
      assert.match(ui.screen.text(), /管理者が設定/u); assert.equal(ui.screen.nodes().some(node => node.type === 'Switch'), false);
      await ui.screen.press('戻る'); assert.equal(ui.backs(), 1); assert.equal((await listSharingOutbox(member.database, groupId)).length, 0);
    } finally { await ui?.close(); member.connection.close(); f.close(); }
  });

  test(`${platform} conflicting grants and revocations require opening and explicitly selecting an authenticated rights bundle`, async () => {
    const f = await setup(); const identity = await createDeviceIdentity(sharingTestCrypto); let ui;
    f.f.archive.push(approveSharedDevice(f.f.archive.at(-1), f.f.owner, 'owner', identity)); const other = await f.f.device('owner', identity); let n = 0;
    const second = createV2GroupController(other.repository, { makeId: () => `rights-other-${++n}`, now, sync: async () => {} });
    const receive = async (d, facts) => { const checkpoint = await readSharingCheckpoint(d.database, groupId);
      await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts))); };
    try {
      await receive(other, await loadSharedFacts(f.d.database, groupId)); const policyIds = ids((await source(f.c)).groupPolicy);
      await f.c.actions.editDateRights('floor', [{ userId: 'member', expectedMembershipStart: 2, value: { enabled: true, rights: { changeDate: true, changeOthers: false, changeBeforeWindow: false } }, basisOperationIds: [] }], policyIds);
      await second.actions.editDateRights('floor', [{ userId: 'member', expectedMembershipStart: 2, value: { enabled: false, rights: { changeDate: true, changeOthers: true, changeBeforeWindow: true } }, basisOperationIds: [] }], policyIds);
      await receive(f.d, await loadSharedFacts(other.database, groupId)); ui = await open(f.c, platform); await expand(ui);
      const current = ui.props.model.dateRights.fields.member; assert.equal(current.kind, 'conflict');
      assert.equal(ui.screen.nodes().some(node => node.type === 'Switch'), false); assert.throws(() => ui.screen.button(`${ui.nameOf('member')}の権限候補1で解決する`), /missing button/u);
      await ui.screen.press(`${ui.nameOf('member')}の権限候補1を開く`); await ui.screen.press(`${ui.nameOf('member')}の権限候補1で解決する`);
      await ui.settle(() => ui.props.model.dateRights.fields.member.kind === 'value');
      assert.deepEqual(ui.props.model.dateRights.fields.member.value, current.candidates[0].value);
    } finally { await ui?.close(); other.connection.close(); f.close(); }
  });

  test(`${platform} a rejoined member receives a fresh editor while the former membership draft stays separate and cannot save`, async () => {
    const f = await setup(); const entered = deferred(); const release = deferred(); let ui;
    const delayed = { ...f.c, actions: { ...f.c.actions, editDateRights: async (...args) => { entered.resolve(); await release.promise; return f.c.actions.editDateRights(...args); } } };
    try {
      ui = await open(delayed, platform); await expand(ui); const before = await listSharingOutbox(f.d.database, groupId);
      control(ui, `${ui.nameOf('member')}への権限を有効にする`).props.onValueChange(true); ui.flushPending(); await entered.promise;
      f.f.archive.push(removeSharedMembers(f.f.archive.at(-1), f.f.owner, ['member']));
      f.f.archive.push(approveSharedDevice(f.f.archive.at(-1), f.f.owner, 'member', f.f.member));
      ui.props.model = await source(f.c); ui.screen.render(); await ui.settle(); release.resolve();
      await ui.settle(() => ui.screen.text().includes('別の変更が届いています'));
      assert.match(ui.screen.text(), /以前の参加/u); assert.equal(ui.props.model.dateRights.membershipStarts.member, 4);
      assert.equal((await source(f.c)).dateRights.fields.member.kind, 'missing'); assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
      await ui.screen.press('入力を最新の権限に戻す'); await ui.settle(); await expand(ui);
      assert.equal(control(ui, `${ui.nameOf('member')}への権限を有効にする`).props.value, false);
    } finally { release.resolve(); await ui?.close(); f.close(); }
  });
}
