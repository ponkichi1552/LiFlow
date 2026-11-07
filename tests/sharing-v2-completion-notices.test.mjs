import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2CompletionNoticeStore } from '../src/platform/storage/sharing-v2-completion-notices.ts';
import { createV2CompletionNoticeRuntime } from '../src/features/sharing/v2/completion-notice-runtime.ts';
import { v2CompletionNoticeCandidates, v2CompletionNoticePrefix } from '../src/features/sharing/v2/completion-notices.ts';
import { applyReceivedSharedFacts, loadSharedFacts, readSharingCheckpoint, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { loadNativeModule } from './helpers/native-module.mjs';
import { v2ReadPoint } from '../src/features/sharing/v2/view-point.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { sharedLocalDate } from '../src/features/sharing/group-clock.ts';

const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const ref = { choreId: 'floor', anchorDate: '2026-10-27', subjectUserId: null };
async function receive(d, facts) {
  const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
}
async function setup({ push = false, selectedOwner = false, show = true } = {}) {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member); let id = 0; let access = true;
  const initial = seeds(); initial[0].payload.configuration.completionPushEnabled = push; initial[0].payload.configuration.showCompletionStatus = show;
  if (selectedOwner) initial[3].payload.configuration.policy = { completion: 'one', assignment: { mode: 'selected', memberIds: ['owner'] } };
  await owner.repository.commit(initial); await receive(member, await loadSharedFacts(owner.database, groupId));
  const a = createV2GroupController(owner.repository, { now, makeId: () => `notice-owner-${++id}`, sync: async () => {} });
  const b = createV2GroupController(member.repository, { now, makeId: () => `notice-member-${++id}`, sync: async () => {} });
  const assertAccess = () => { if (!access) throw new Error('account changed'); };
  const options = { repository: owner.repository, userId: 'owner', groupId, assertAccess };
  const store = createV2CompletionNoticeStore(options); const notices = []; const permissionReads = []; let permitted = true;
  const runtimeInput = { userId: 'owner', groupId, store, now, assertAccess, hasPermission: async () => { permissionReads.push(true); return permitted; },
    present: async (notice, guard, issue) => { await guard(); if (await issue()) notices.push(structuredClone(notice)); } };
  return { f, owner, member, a, b, store, options, notices, permissionReads, runtimeInput,
    runtime: createV2CompletionNoticeRuntime(runtimeInput), async receivedCompletion(target = ref) { const done = await b.actions.complete(target); await receive(owner, await loadSharedFacts(member.database, groupId)); return done; },
    permission(value) { permitted = value; }, stop() { access = false; }, close() { owner.connection.close(); member.connection.close(); } };
}
test('v2 completion notices default off and never request permission or read a personal planner', async () => {
  const h = await setup(); try {
    await h.runtime.synchronize(); await h.receivedCompletion(); const before = await listSharingOutbox(h.owner.database, groupId);
    await h.runtime.synchronize(); assert.deepEqual(h.permissionReads, []); assert.deepEqual(h.notices, []);
    assert.deepEqual(await listSharingOutbox(h.owner.database, groupId), before); assert.equal(h.owner.connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0);
  } finally { h.close(); }
});
test('v2 completion notification baseline skips old history then presents one received round only once across restart', async () => {
  const h = await setup({ push: true }); try {
    await h.runtime.synchronize(); await h.receivedCompletion(); const before = await listSharingOutbox(h.owner.database, groupId);
    const running = Array.from({ length: 100 }, () => h.runtime.synchronize()); assert.equal(new Set(running).size, 1); await running[0];
    assert.equal(h.notices.length, 1); assert.equal(h.notices[0].count, 1); assert.equal(h.notices[0].body, '床を掃除する'); assert.ok(h.notices[0].key.startsWith(v2CompletionNoticePrefix('owner', groupId)));
    const restored = createV2CompletionNoticeRuntime({ ...h.runtimeInput, store: createV2CompletionNoticeStore(h.options) });
    await restored.synchronize(); await restored.synchronize(); assert.equal(h.notices.length, 1);
    assert.deepEqual(await listSharingOutbox(h.owner.database, groupId), before);
  } finally { h.close(); }
});
test('v2 completion notices do not replay old work after enabling the group setting or granting OS permission', async () => {
  const h = await setup(); try {
    await h.runtime.synchronize(); await h.receivedCompletion(); await h.a.actions.patchGroupPolicy({ completionPushEnabled: true });
    await h.runtime.synchronize(); assert.equal(h.notices.length, 0);
    h.permission(false); await h.runtime.synchronize();
    await receive(h.member, await loadSharedFacts(h.owner.database, groupId)); await h.receivedCompletion({ ...ref, anchorDate: '2026-11-03' });
    await h.runtime.synchronize(); h.permission(true); await h.runtime.synchronize(); assert.equal(h.notices.length, 0);
    await h.receivedCompletion({ ...ref, anchorDate: '2026-11-10' }); await h.runtime.synchronize(); assert.equal(h.notices.length, 1);
  } finally { h.close(); }
});
test('v2 own completion, pending approval, unconfirmed performed time and undone work cannot become another-member notices', async () => {
  const h = await setup({ push: true }); try {
    await h.runtime.synchronize(); await h.a.actions.complete(ref); await h.runtime.synchronize(); assert.equal(h.notices.length, 0);
    await h.receivedCompletion({ ...ref, anchorDate: '2026-11-03' }); const model = await h.a.readModel(range); const record = model.plan.history.find(row => row.recorderUserId === 'member');
    for (const changed of [{ active: false }, { acceptance: 'pending' }, { performedTimeConfirmed: false }, { outcome: 'incomplete' }]) {
      assert.deepEqual(v2CompletionNoticeCandidates({ ...model.plan, history: [{ ...record, ...changed }] }, 'owner', 'owner'), []);
    }
  } finally { h.close(); }
});
test('v2 completion notices normalize concurrent history and preserve the completion display preference', async () => {
  const h = await setup({ push: true, selectedOwner: true, show: false }); try {
    await h.a.actions.complete(ref); await receive(h.member, await loadSharedFacts(h.owner.database, groupId)); const model = await h.b.readModel(range);
    const history = model.plan.history[0]; const duplicate = { ...history, operationId: 'concurrent-completion', recorderUserId: 'member' };
    const rows = v2CompletionNoticeCandidates({ ...model.plan, history: [history, duplicate] }, 'member', 'owner');
    assert.equal(rows.length, 1); assert.equal(rows[0].notify, false);
    assert.equal(v2CompletionNoticeCandidates({ ...model.plan, history: [duplicate, history] }, 'member', 'owner')[0].notify, false);
    assert.equal(v2CompletionNoticeCandidates({ ...model.plan, policy: { ...model.plan.policy, showCompletionStatus: true } }, 'member', 'owner')[0].notify, true);
    assert.throws(() => v2CompletionNoticeCandidates(model.plan, 'outsider', 'owner'), /共有グループ/u);
  } finally { h.close(); }
});
test('v2 completion notice SQLite failure rolls back claims and retry has no shared or personal side effects', async () => {
  const h = await setup({ push: true }); const run = h.owner.database.runAsync;
  try {
    await h.runtime.synchronize(); await h.receivedCompletion(); let injected = false;
    h.owner.database.runAsync = async (sql, ...args) => { const value = await run(sql, ...args);
      if (!injected && sql.startsWith('INSERT INTO sharing_v2_private_notice_seen')) { injected = true; throw new Error('notice SQL failure'); } return value; };
    await assert.rejects(h.runtime.synchronize(), /notice SQL failure/u); assert.equal(h.notices.length, 0);
    assert.equal(h.owner.connection.prepare('SELECT COUNT(*) AS n FROM sharing_v2_private_notice_seen').get().n, 0);
    h.owner.database.runAsync = run; await h.runtime.synchronize(); assert.equal(h.notices.length, 1);
  } finally { h.owner.database.runAsync = run; h.close(); }
});
test('v2 notification delivery uncertainty keeps a durable claim instead of repeating an OS request after restart', async () => {
  const h = await setup({ push: true }); let attempts = 0;
  try {
    await h.runtime.synchronize(); await h.receivedCompletion();
    const failing = createV2CompletionNoticeRuntime({ ...h.runtimeInput, present: async (_notice, guard, issue) => { await guard(); if (await issue()) { attempts++; throw new Error('OS reply lost'); } } });
    await assert.rejects(failing.synchronize(), /OS reply lost/u);
    const restarted = createV2CompletionNoticeRuntime({ ...h.runtimeInput, store: createV2CompletionNoticeStore(h.options) }); await restarted.synchronize();
    assert.equal(attempts, 1); assert.equal(h.notices.length, 0, 'delivery is best effort, not falsely recorded as delivered');
  } finally { h.close(); }
});

test('a known pre-request abort requeues a notice, while another collector cannot refund the active issuer', async () => {
  const h = await setup({ push: true });
  try {
    await h.runtime.synchronize(); await h.receivedCompletion();
    const stale = await h.store.collect(true, now()); const active = await h.store.collect(true, now());
    assert.notEqual(stale.issueToken, active.issueToken);
    assert.equal(await h.store.issue(active, async () => {}), true);
    await h.store.notIssued(stale);
    assert.equal(h.owner.connection.prepare('SELECT claimed FROM sharing_v2_private_notice_seen').get().claimed, 1);
    assert.equal(await h.store.collect(true, now()), null, 'an unrelated collector cannot cause duplicate delivery');
    await h.store.notIssued(active);
    const retry = await h.store.collect(true, now()); assert.ok(retry);
    assert.equal(await h.store.issue(retry, async () => {}), true);
    await h.store.notIssued(active); await h.store.settled(active);
    assert.equal(h.owner.connection.prepare('SELECT claimed FROM sharing_v2_private_notice_seen').get().claimed, 1);
    assert.equal(await h.store.collect(true, now()), null, 'a late abort cannot undo a newer issuance');
    await h.store.settled(retry);
    assert.equal(h.owner.connection.prepare('SELECT count(*) n FROM sharing_v2_private_notice_issued').get().n, 0);
  } finally { h.close(); }
});

test('a native request known not to have started remains available after runtime restart', async () => {
  const h = await setup({ push: true });
  try {
    await h.runtime.synchronize(); await h.receivedCompletion(); let attempts = 0;
    const interrupted = createV2CompletionNoticeRuntime({ ...h.runtimeInput, present: async (_notice, guard, issue) => {
      await guard(); assert.equal(await issue(), true); attempts++; return false;
    } });
    await interrupted.synchronize(); assert.equal(attempts, 1);
    assert.equal(h.owner.connection.prepare('SELECT count(*) n FROM sharing_v2_private_notice_pending').get().n, 1);
    const restored = createV2CompletionNoticeRuntime({ ...h.runtimeInput, store: createV2CompletionNoticeStore(h.options) });
    await restored.synchronize(); await restored.synchronize(); assert.equal(h.notices.length, 1);
  } finally { h.close(); }
});

test('a candidate survives a pre-send interruption and an unrelated shared change, then issues only once',async()=>{
  const h=await setup({push:true});
  try {
    await h.runtime.synchronize();await h.receivedCompletion();
    const batch=await h.store.collect(true,now());assert.ok(batch);
    assert.equal(h.owner.connection.prepare('SELECT claimed FROM sharing_v2_private_notice_seen').get().claimed,0);
    await h.a.actions.patchGroupPolicy({showCompletionStatus:false});
    assert.equal(await h.store.current(batch),false);
    await assert.rejects(h.store.issue(batch,async()=>{throw new Error('before-send deadline');}),/deadline/);
    const restarted=createV2CompletionNoticeRuntime({...h.runtimeInput,store:createV2CompletionNoticeStore(h.options)});
    await restarted.synchronize();await restarted.synchronize();
    assert.equal(h.notices.length,1);assert.equal(h.owner.connection.prepare('SELECT claimed FROM sharing_v2_private_notice_seen').get().claimed,1);
    assert.equal(h.owner.connection.prepare('SELECT count(*) n FROM sharing_v2_private_notice_pending').get().n,0);
  }finally{h.close();}
});
test('v2 notice permissions policy and workspace are rechecked before a native presentation', async () => {
  for (const change of ['policy', 'account', 'revision']) {
    const h = await setup({ push: true });
    try {
      await h.runtime.synchronize(); await h.receivedCompletion(); let reads = 0;
      const runtime = createV2CompletionNoticeRuntime({ ...h.runtimeInput, hasPermission: async () => {
        if (++reads === 1) { if (change === 'policy') await h.a.actions.patchGroupPolicy({ completionPushEnabled: false });
          else if (change === 'account') h.stop(); }
        else if (change === 'revision') await h.a.actions.patchGroupPolicy({ completionPushEnabled: false });
        return true;
      } });
      if (change === 'account') await assert.rejects(runtime.synchronize(), /account changed/u); else await runtime.synchronize();
      assert.equal(h.notices.length, 0);
    } finally { h.close(); }
  }
});
test('v2 completion notice stores and runtimes reject foreign scope before access and malformed saved claims fail closed', async () => {
  const h = await setup({ push: true }); try {
    assert.throws(() => createV2CompletionNoticeStore({ ...h.options, userId: 'other' }), /保存先/u);
    assert.throws(() => createV2CompletionNoticeRuntime({ ...h.runtimeInput, groupId: 'other' }), /本人/u);
    await h.runtime.synchronize(); await h.receivedCompletion();
    h.owner.connection.prepare('INSERT INTO sharing_v2_private_notice_seen VALUES (?,?)').run('not-a-hash', 0);
    await assert.rejects(h.runtime.synchronize(), /確認記録/u); assert.equal(h.notices.length, 0);
  } finally { h.close(); }
});
test('v2 completion notice projection handles thousands of received subjects without per-event native requests', async () => {
  const h = await setup({ push: true }); try {
    await h.receivedCompletion(); const model = await h.a.readModel(range); const base = model.plan.history[0];
    const history = Array.from({ length: 5000 }, (_, index) => ({ ...base, subjectOccurrenceId: `subject-${index}`, operationId: `complete-${index}` }));
    const rows = v2CompletionNoticeCandidates({ ...model.plan, history }, 'owner', 'owner'); assert.equal(rows.length, 5000);
    let consumed = false; const store = { scope: { userId: 'owner', groupId }, enabled: async () => true, current: async () => true, issue: async () => true,
      collect: async () => consumed ? null : (consumed = true, { revision: 'a'.repeat(64), keys: rows.map(row => row.key), names: rows.map(row => row.name) }) };
    const runtime = createV2CompletionNoticeRuntime({ ...h.runtimeInput, store }); await runtime.synchronize(); await runtime.synchronize();
    assert.equal(h.notices.length, 1); assert.equal(h.notices[0].count, 5000); assert.match(h.notices[0].body, /ほか4996件/u);
  } finally { h.close(); }
});
test('v2 notice baseline batches five thousand private claims by100 and a budget interruption rolls the whole batch back', async () => {
  const h = await setup({ push: true }); const run = h.owner.database.runAsync;
  try {
    await h.receivedCompletion(); const model = await h.a.readModel(range); const base = model.plan.history[0];
    const history = Array.from({ length: 5000 }, (_, index) => ({ ...base, subjectOccurrenceId: `many-subject-${index}`, operationId: `many-complete-${index}` }));
    const module = loadNativeModule('src/platform/storage/sharing-v2-completion-notices.ts', {
      '../../features/sharing/v2/common-plan.ts': { buildV2CommonPlan: () => ({ ...model.plan, history }) },
      '../../features/sharing/v2/view-point.ts': { v2ReadPoint }, '../../features/sharing/group-clock.ts': { sharedLocalDate },
      '../../features/sharing/v2/completion-notices.ts': { v2CompletionNoticeCandidates }, '../../features/sharing/crypto.ts': {sharedDocumentDigest},
    });
    const store = module.createV2CompletionNoticeStore(h.options); const batches = [];
    h.owner.database.runAsync = async (sql, ...args) => { if (sql.startsWith('INSERT INTO sharing_v2_private_notice_seen')) batches.push(args.length / 2); return run(sql, ...args); };
    let checked = 0; await assert.rejects(store.collect(true, now(), () => { if (++checked === 3) throw new Error('notice budget expired'); }), /budget expired/u);
    assert.equal(h.owner.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='sharing_v2_private_notice_seen'").get().n, 0, 'even first-use schema creation rolls back');
    batches.length = 0; assert.equal(await store.collect(true, now()), null);
    assert.deepEqual(batches, Array(50).fill(100)); assert.equal(h.owner.connection.prepare('SELECT COUNT(*) AS n FROM sharing_v2_private_notice_seen').get().n, 5000);
    assert.equal(h.notices.length, 0, 'an initial baseline never floods the OS with historical work');
  } finally { h.owner.database.runAsync = run; h.close(); }
});

test('audit100 a completion notice refresh removes obsolete pending subjects in one bounded statement while preserving current notices',async()=>{
 const h=await setup({push:true});try{
  await h.store.collect(true,now());await h.receivedCompletion();const current=await h.store.collect(true,now());assert.equal(current.keys.length,1);
  for(let i=0;i<200;i++)h.owner.connection.prepare('INSERT INTO sharing_v2_private_notice_pending VALUES(?,?)').run(sharedDocumentDigest(['obsolete',i]),'old completion');
  const run=h.owner.database.runAsync;let deletes=0;h.owner.database.runAsync=async(sql,...args)=>{if(sql.startsWith('DELETE FROM sharing_v2_private_notice_pending'))deletes++;return run(sql,...args);};
  const next=await h.store.collect(true,now());assert.deepEqual(next.keys,current.keys);assert.equal(h.owner.connection.prepare('SELECT COUNT(*) AS n FROM sharing_v2_private_notice_pending').get().n,1);assert.ok(deletes<=2,`obsolete notice deletes ${deletes}`);
 }finally{h.close();}
});
