import { installFrozenSchedulerFixture } from './helpers/frozen-scheduler-fixture.mjs';
import { plannerLightColors } from '../src/components/planner-theme.ts';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { commonChoreLinks, parseSharedMirrorEntryId } from '../src/features/planner/common-chore-links.ts';
import { registerSharedRepositoryAdapter } from '../src/platform/storage/shared-repository-adapter.ts';
import { localDateFromDate, addDays } from '../src/domain/scheduling/local-date.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { sharedGroupBootstrap } from '../src/features/sharing/planning.ts';
import { createLocalSharedOperations, initializeSharingLedger, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { initializeSharedProjection } from '../src/platform/storage/sharing-projection.ts';
import { createSharedPlannerRepository } from '../src/platform/storage/shared-planner-repository.ts';
import { v2CommonCompletionSource } from '../src/features/sharing/v2-ui/common-chore-history.ts';
import { createCommonChoreHistoryBridge } from '../src/features/planner/common-chore-history-bridge.ts';
const repository = await import('../src/platform/storage/repository.ts');
const now = new Date(); const today = localDateFromDate(now);
async function fixture() {
  const h = createDatabase(); await repository.initializeLocalDatabase(h.database); await installFrozenSchedulerFixture(h.database);
  const initial = await repository.loadPlannerSnapshot(h.database, today);
  const personal = initial.chores[0];
  await repository.completeFirstSetup(h.database, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [personal.id], previousDates: {}, weatherLocation: null });
  const snapshot = await repository.loadPlannerSnapshot(h.database, today);
  const shared = { ...snapshot.chores.find(c => c.id === personal.id), id: 'shared-chore', userIntervalDays: 1, load: 'light' };
  const fact = { id: 'remote-completion', householdId: 'local-household', choreId: shared.id, scheduleEntryId: 'shared-occurrence', completedAt: now.toISOString(),
    outcome: 'completed', source: 'inApp', scheduledDate: today, scheduledWindowStart: today, scheduledWindowEnd: today };
  const input = { groupId: 'group-test', chores: [shared], completions: [fact] };
  return { ...h, snapshot, personal: snapshot.chores.find(c => c.id === personal.id), shared, fact, input,
    apply: (source = input, guard = async () => {}) => repository.mirrorSharedChoreCompletions(h.database, source, guard) };
}
test('common home chores use the active group definition while preserving disabled personal defaults and safe name matching', async () => {
  const h = await fixture();
  try {
    const original = JSON.stringify(h.personal);
    assert.deepEqual(commonChoreLinks([{ ...h.personal, enabled: false }], [h.shared]), [{ sharedChoreId: h.shared.id, personalChoreId: h.personal.id }]);
    for (const patch of [{ enabled: false }, { archived: true }, { name: `${h.shared.name}別の作業` }])
      assert.deepEqual(commonChoreLinks([h.personal], [{ ...h.shared, ...patch }]), []);
    assert.deepEqual(commonChoreLinks([h.personal], [h.shared, { ...h.shared, id: 'ambiguous' }]), []);
    assert.deepEqual(commonChoreLinks([h.personal, { ...h.personal, id: 'a-different-personal-appliance' }], [h.shared]), [],
      'one generic shared name cannot complete two distinct personal targets');
    assert.equal(JSON.stringify(h.personal), original);
  } finally { h.connection.close(); }
});
test('shared completion mirrors replay once restore the original personal settings and accept remote undo without touching unrelated history', async () => {
  const h = await fixture();
  try {
    const before = h.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(h.personal.id);
    const personalEntry = h.snapshot.scheduleEntries.find(e => e.choreId === h.personal.id);
    await repository.completeChore(h.database, personalEntry);
    const original = h.connection.prepare('SELECT * FROM chore_completions').get();
    assert.equal(await h.apply(), 1); assert.equal(await h.apply(), 0);
    let records = (await repository.loadPlannerSnapshot(h.database, today)).completions;
    const mirror = records.find(record => parseSharedMirrorEntryId(record.scheduleEntryId));
    assert.equal(mirror.outcome, 'completed'); assert.equal(records.length, 2);
    assert.equal(await h.apply({ ...h.input, completions: [{ ...h.fact, outcome: 'incomplete' }] }), 1);
    assert.equal(await h.apply({ ...h.input, completions: [{ ...h.fact, outcome: 'incomplete' }] }), 0);
    assert.deepEqual(h.connection.prepare('SELECT * FROM chore_completions WHERE id=?').get(original.id), original);
    assert.deepEqual(h.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(h.personal.id), before);
    assert.equal(await h.apply(), 1); assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 2);
    assert.equal(await h.apply({ ...h.input, completions: [] }), 0, 'an absent fact is not evidence of undo');
  } finally { h.connection.close(); }
});
test('remote undo still addresses its original local mirror after a group chore is disabled or renamed', async () => {
  const h = await fixture();
  try {
    await h.apply();
    assert.equal(await h.apply({ ...h.input, chores: [{ ...h.shared, enabled: false, name: 'renamed' }], completions: [{ ...h.fact, outcome: 'incomplete' }] }), 1);
    assert.equal((await repository.loadPlannerSnapshot(h.database, today)).completions[0].outcome, 'incomplete');
    assert.equal(commonChoreLinks([h.personal], [{ ...h.shared, enabled: false }]).length, 0, 'disabled shared work restores the original personal definition');
  } finally { h.connection.close(); }
});
test('common history mirror transactions roll back on access loss and never initialize or mutate a shared database', async () => {
  const h = await fixture(); let calls = 0;
  try {
    await assert.rejects(h.apply(h.input, async () => { if (++calls === 3) throw new Error('membership changed'); }), /membership changed/);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 0);
    const stop = registerSharedRepositoryAdapter(h.database, { groupId: 'group-test', userId: 'owner' });
    const writes = h.writes.length;
    try { await assert.rejects(h.apply(), /個人の保存先/u); assert.equal(h.writes.length, writes); } finally { stop(); }
    assert.equal(await h.apply(), 1, 'a rolled-back mirror remains safely retryable');
  } finally { h.connection.close(); }
});
test('separate group occurrences with equal identifiers retain separate mirrors and an undo never cancels another group', async () => {
  const h = await fixture();
  try {
    await h.apply(); await h.apply({ ...h.input, groupId: 'other-group' });
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 2);
    await h.apply({ ...h.input, completions: [{ ...h.fact, outcome: 'incomplete' }] });
    const records = (await repository.loadPlannerSnapshot(h.database, today)).completions;
    assert.equal(records.find(r => parseSharedMirrorEntryId(r.scheduleEntryId).groupId === 'other-group').outcome, 'completed');
    assert.equal(records.find(r => parseSharedMirrorEntryId(r.scheduleEntryId).groupId === 'group-test').outcome, 'incomplete');
  } finally { h.connection.close(); }
});

test('v2 common history reflects other members and explicit undo but excludes another persons individual subject and unapproved work', () => {
  const record = { operationId: 'remote', occurrenceId: 'round', subjectOccurrenceId: 'common', choreId: 'floor', anchorDate: today,
    subjectUserId: null, performerUserId: 'member', recorderUserId: 'member', performedAt: now.toISOString(), active: true, outcome: 'completed',
    acceptance: 'accepted', approvalConflictIds: [], schedule: null };
  const model = { viewerUserId: 'owner', plan: { groupId: 'group-test', chores: [], history: [record] } };
  assert.equal(v2CommonCompletionSource(model).completions[0].outcome, 'completed');
  for (const patch of [{ active: false }, { acceptance: 'pending' }, { acceptance: 'rejected' }, { approvalConflictIds: ['conflict'] }]) {
    model.plan.history = [{ ...record, ...patch }]; assert.equal(v2CommonCompletionSource(model).completions[0].outcome, 'incomplete');
  }
  model.plan.history = [{ ...record, subjectUserId: 'member' }]; assert.deepEqual(v2CommonCompletionSource(model).completions, []);
  model.plan.history = [{ ...record, active: false }, { ...record, operationId: 'other-active' }];
  assert.equal(v2CommonCompletionSource(model).completions[0].outcome, 'completed', 'undoing one report cannot cancel another valid completion');
});

test('common history bridge coalesces one hundred syncs and retries a committed mirror read without another completion', async () => {
  const h = await fixture(); let unlock; let current = true; const changed = [];
  const gate = new Promise(resolve => { unlock = resolve; }); let authorizations = 0, applies = 0;
  const snapshot = { ...h.snapshot, sharing: { groupId: h.input.groupId }, chores: [h.shared], completions: [h.fact] };
  const bridge = createCommonChoreHistoryBridge({ groupId: h.input.groupId, isCurrent: () => current, read: () => snapshot,
    authorize: async () => { if (++authorizations === 1) await gate; },
    apply: async (source, guard) => { applies++; return h.apply(source, guard); },
    afterChange: async value => { changed.push(value); if (changed.length === 1) throw new Error('read failed after commit'); } });
  try {
    const attempts = Array.from({ length: 100 }, () => bridge.sync()); assert.ok(attempts.every(p => p === attempts[0])); unlock();
    await assert.rejects(attempts[0], /read failed/); assert.equal(applies, 1);
    await bridge.sync(); assert.equal(applies, 2); assert.deepEqual(changed, [true, false]);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 1);
    current = false; await assert.rejects(bridge.sync(), /アカウント/u);
  } finally { h.connection.close(); }
});

test('a changing group snapshot rolls back the old mirror before replaying the latest canonical outcome', async () => {
  const h = await fixture(); let calls = 0;
  let snapshot = { ...h.snapshot, sharing: { groupId: h.input.groupId }, chores: [h.shared], completions: [h.fact] };
  const bridge = createCommonChoreHistoryBridge({ groupId: h.input.groupId, isCurrent: () => true, read: () => snapshot, authorize: async () => {},
    apply: async (source, guard) => {
      if (++calls === 1) snapshot = { ...snapshot, completions: [{ ...h.fact, outcome: 'incomplete' }] };
      return h.apply(source, guard);
    }, afterChange: async () => {} });
  try {
    await bridge.sync(); assert.equal(calls, 2);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM chore_completions').get().n, 0);
  } finally { h.connection.close(); }
});

test('one thousand confirmed common completions replay without per-record SQLite reads or writes', async () => {
  const h = await fixture();
  try {
    const completions = Array.from({ length: 1000 }, (_, index) => ({ ...h.fact, id: `history-${index}`, scheduleEntryId: `occurrence-${index}`,
      completedAt: new Date(now.getTime() - (1000 - index) * 86400000).toISOString(), scheduledDate: addDays(today, index - 1000),
      scheduledWindowStart: addDays(today, index - 1000), scheduledWindowEnd: addDays(today, index - 1000) }));
    await h.apply({ ...h.input, completions });
    let reads = 0; const original = h.database.getFirstAsync;
    h.database.getFirstAsync = async (...args) => { reads++; return original(...args); };
    const writes = h.writes.length; let authorizations = 0;
    assert.equal(await h.apply({ ...h.input, completions }, async () => { authorizations++; }), 0);
    assert.ok(reads <= 2, `${reads} per-record queries would delay each home refresh`);
    assert.ok(authorizations <= 3, `${authorizations} per-record membership reads would delay each home refresh`);
    assert.equal(h.writes.length, writes);
  } finally { h.connection.close(); }
});

async function sharedFixture(personal) {
  const h = createDatabase(); const identity = await createDeviceIdentity(crypto);
  const scope = { userId: 'owner', groupId: 'group-common', householdId: repository.LOCAL_HOUSEHOLD_ID };
  const roster = createSharedRoster(scope.groupId, scope.userId, identity); let id = 0;
  await initializeSharedProjection(h.database, scope); await initializeSharingLedger(h.database);
  const adapter = createSharedPlannerRepository(h.database, { ...scope, identity, roster: () => roster, now: () => now, makeId: () => `common-${++id}` });
  await createLocalSharedOperations(h.database, { ...scope, deviceId: identity.deviceId, keyVersion: 1 }, sharedGroupBootstrap({ ...scope,
    ownerUserId: 'owner', ownerDisplayName: '自分', name: '家族', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, anchorDate: today }), adapter.project,
  operation => signSharedOperation(operation, identity).authorSignature);
  const unregister = registerSharedRepositoryAdapter(h.database, adapter);
  const read = () => repository.loadPlannerSnapshot(h.database, today, now);
  const shared = (await read()).chores.find(chore => chore.name === personal.name);
  await repository.updateChoreDefinition(h.database, { ...shared, enabled: true, load: 'light', userIntervalDays: 1 });
  return { ...h, scope, read, close: () => { unregister(); h.connection.close(); } };
}

for (const platform of ['ios', 'android']) test(`${platform} common home uses one group row and completes undoes and recovers personal history without sending private settings`, async () => {
  const h = await fixture(); const shared = await sharedFixture(h.personal); const navigation = [], google = [];
  try {
    const extra = h.snapshot.chores.find(chore => chore.id !== h.personal.id);
    await repository.updateChoreDefinition(h.database, { ...extra, name: '本人だけの家事', enabled: true });
    let snapshot = await shared.read(); let personalSnapshot = await repository.loadPlannerSnapshot(h.database, today);
    const definitions = h.connection.prepare('SELECT id,enabled,definition_json FROM chore_definitions ORDER BY id').all();
    const personalData = { database: h.database, readSnapshot: () => personalSnapshot, snapshot: personalSnapshot, loading: false, error: null,
      readError: () => null, refresh: async () => { personalSnapshot = await repository.loadPlannerSnapshot(h.database, today); personalData.snapshot = personalSnapshot; } };
    const active = { protocol: 1, ...shared.scope, database: shared.database, record: async () => ({ status: 'active' }) };
    const context = { active, userId: 'owner', group: { ...shared.scope, displayName: '家族' } };
    const screen = screenHarness('src/app/(tabs)/index.tsx', { platform, database: shared.database, snapshot: () => snapshot,
      refresh: async () => { snapshot = await shared.read(); }, personalData: () => personalData, navigate: (...args) => navigation.push(args), mocks: {
        '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: context } },
        '@/features/google-sync/coordinator': { syncGoogleTasksAfterLocalCompletion: db => google.push(db) },
        '../features/google-sync/coordinator': { syncGoogleTasksAfterLocalCompletion: db => google.push(db) },
      } });
    const boxes = () => screen.nodes().filter(node => node.props.accessibilityRole === 'checkbox');
    assert.ok(screen.text().includes('2件中0件が完了しました')); assert.ok(screen.text().includes('家族'));
    const commonLabel = `${h.personal.name}（家族）`;
    const privateLabel = '本人だけの家事（個人）';
    assert.ok(boxes().some(node => node.props.accessibilityLabel === `${commonLabel}を完了`));
    assert.equal(boxes().some(node => node.props.accessibilityLabel === `${h.personal.name}（個人）を完了`), false);
    const before = await listSharingOutbox(shared.database, shared.scope.groupId);
    await boxes().find(node => node.props.accessibilityLabel === `${commonLabel}を完了`).props.onPress(); await screen.flush();
    assert.ok(boxes().some(node => node.props.accessibilityLabel === `${commonLabel}を未完了に戻す`));
    assert.equal(personalSnapshot.completions.filter(record => record.outcome === 'completed').length, 1);
    assert.equal((await listSharingOutbox(shared.database, shared.scope.groupId)).length, before.length + 1);
    assert.ok(google.includes(shared.database) && google.includes(h.database));
    await screen.press('直前の完了を元に戻す');
    assert.equal(personalSnapshot.completions.filter(record => record.outcome === 'completed').length, 0);
    assert.equal((await listSharingOutbox(shared.database, shared.scope.groupId)).length, before.length + 2);
    const afterGroup = await listSharingOutbox(shared.database, shared.scope.groupId);
    await boxes().find(node => node.props.accessibilityLabel === `${privateLabel}を完了`).props.onPress(); await screen.flush();
    assert.deepEqual(await listSharingOutbox(shared.database, shared.scope.groupId), afterGroup);
    await screen.press('直前の完了を元に戻す');
    await screen.press(`${privateLabel}の説明を開く`);
    assert.equal(navigation.at(-1)[1].params.source, 'personal');
    assert.deepEqual(h.connection.prepare('SELECT id,enabled,definition_json FROM chore_definitions ORDER BY id').all(), definitions);
    await repository.updateChoreDefinition(shared.database, { ...snapshot.chores.find(chore => chore.name === h.personal.name), enabled: false });
    snapshot = await shared.read(); screen.render();
    assert.ok(boxes().some(node => node.props.accessibilityLabel === `${h.personal.name}（個人）を完了`), 'removing the group chore restores the untouched personal definition');
    const oldPersonal = boxes().find(node => node.props.accessibilityLabel === `${h.personal.name}（個人）を完了`);
    await repository.updateChoreDefinition(shared.database, { ...snapshot.chores.find(chore => chore.name === h.personal.name), enabled: true });
    snapshot = await shared.read();
    const beforeOldHandler = h.connection.prepare('SELECT * FROM chore_completions').all();
    await oldPersonal.props.onPress(); await screen.flush();
    assert.deepEqual(h.connection.prepare('SELECT * FROM chore_completions').all(), beforeOldHandler, 'an old private checkbox cannot write after the chore becomes common');
  } finally { shared.close(); h.connection.close(); }
});

function allHosts(items) { return items.flatMap(node => typeof node === 'object' && node ? [node, ...allHosts(node.children ?? [])] : []); }
for (const platform of ['ios', 'android']) test(`${platform} home list has a leading independent check a full row opener blue disclosure and legible person icons`, async () => {
  const h = await fixture(); let opened = 0, checked = 0;
  try {
    const props = { chore: h.personal, home: true, mixedSources: true, source: 'personal', onOpen: () => opened++, onToggle: () => checked++ };
    const screen = screenHarness('src/components/task-checkbox-row.tsx', { exportName: 'TaskCheckboxRow', platform, props });
    const opener = screen.button(`${h.personal.name}の説明を開く`);
    const check = screen.nodes().find(node => node.props.accessibilityRole === 'checkbox'); assert.ok(check);
    assert.equal(allHosts(opener.children).some(node => node.props.accessibilityRole === 'checkbox'), false);
    await check.props.onPress(); assert.equal(checked, 1); assert.equal(opened, 0);
    await screen.press(`${h.personal.name}の説明を開く`); assert.equal(opened, 1); assert.equal(checked, 1);
    assert.equal(screen.text().includes('手順を見る'), false); assert.equal(screen.text().includes('個人'), false);
    const icons = () => allHosts(screen.render()).filter(node => node.type === 'SymbolView');
    assert.ok(icons().some(node => node.props.name.ios === 'person.fill'));
    props.source = 'shared'; screen.render();
    assert.ok(icons().some(node => node.props.name.ios === 'person.3.fill'));
    const stroke = allHosts(screen.render()).find(node => Array.isArray(node.props.style) && node.props.style.some(style => style?.borderRightWidth === 2));
    assert.equal(stroke.props.style.find(style => style?.borderColor).borderColor, plannerLightColors.accent);
  } finally { h.connection.close(); }
});
