import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, groupId, anchorDate } from './helpers/sharing-v2-plan-fixture.mjs';
import { createV2ReminderRequests, validateV2ReminderPreferences } from '../src/features/sharing/v2/reminders.ts';
import { v2NativeWorkspaceNamespace, v2NotificationPrefix } from '../src/features/sharing/v2/native-identity.ts';
import { sharedGoogleNamespace } from '../src/features/google-sync/workspace-policy.ts';
import { notificationWorkspace } from '../src/features/notifications/workspace-response.ts';
import { buildV2PersonalPlan } from '../src/features/sharing/v2/personal-plan.ts';

const now = new Date('2026-10-26T23:00:00Z');
const preferences = { enabled: true, hour: 9, minute: 0 };
const range = { from: '2026-10-22', through: '2026-11-26', asOfDate: anchorDate };
function model(f, userId = 'a') { return { viewerUserId: userId, adminUserId: 'owner', plan: f.plan(range) }; }
function requests(f, userId = 'a', extra = {}) {
  return createV2ReminderRequests({ model: model(f, userId), userId, groupId, preferences, now, ...extra }).requests;
}

test('v2 unassigned common chores remind each member with a protocol/owner/group-separated opaque scope', async () => {
  const f = await fixture();
  for (const uid of ['owner', 'a', 'b']) {
    const all = requests(f, uid); assert.ok(all.length > 0); assert.ok(all.every(row => row.body.includes('床を掃除する')));
    assert.ok(all.every(row => row.key.startsWith(v2NotificationPrefix(uid, groupId)) && row.data.kind === 'v2-housework-digest'));
    assert.notEqual(all[0].data.workspace, sharedGoogleNamespace(uid, groupId));
    assert.ok(all.every(row => Object.keys(row.data).sort().join(',') === 'date,kind,workspace'));
  }
  assert.notEqual(v2NativeWorkspaceNamespace('a', groupId), v2NativeWorkspaceNamespace('b', groupId));
});

test('v2 reminders follow a claim and do not nag another person even when the viewer is administrator', async () => {
  const f = await fixture();
  f.make('claim', { choreId: 'floor', anchorDate, occurrenceId: f.occurrence(), userId: 'a' }, { actor: 'a' });
  assert.ok(requests(f, 'a').some(row => row.data.date === anchorDate));
  for (const uid of ['b', 'owner']) assert.ok(!requests(f, uid).some(row => row.data.date === anchorDate));
});

test('v2 concurrent claims remind the actual provisional claimants, not unrelated members', async () => {
  const f = await fixture(); const before = f.facts.map(row => row.operation);
  for (const actor of ['a', 'b']) f.make('claim', { choreId: 'floor', anchorDate, occurrenceId: f.occurrence(), userId: actor }, { actor, observed: before });
  for (const uid of ['a', 'b']) assert.ok(requests(f, uid).some(row => row.data.date === anchorDate));
  assert.ok(!requests(f, 'owner').some(row => row.data.date === anchorDate));
});

test('v2 one completion suppresses the common round on every member while targeted undo restores it', async () => {
  const f = await fixture(); const done = f.complete();
  for (const uid of ['owner', 'a', 'b']) assert.ok(!requests(f, uid).some(row => row.data.date === anchorDate));
  f.make('completion', { targetOperationId: done.operationId }, { actor: 'a', entityId: done.entityId, operationType: 'undo' });
  assert.ok(requests(f).some(row => row.data.date === anchorDate));
});

test('v2 each-member completion cancels only that person’s reminder', async () => {
  const f = await fixture({ preset: 'eachMember' }); f.complete({ actor: 'a', subject: 'a' });
  assert.ok(!requests(f, 'a').some(row => row.data.date === anchorDate));
  assert.ok(requests(f, 'b').some(row => row.data.date === anchorDate));
});

test('v2 fixed date reminders preserve the designation rather than choosing a new day from Calendar', async () => {
  const f = await fixture(); f.designation({ precision: 'interval', start: '2026-10-28T10:00:00Z', end: '2026-10-28T10:30:00Z' }, { adminLocked: true });
  const first = requests(f).filter(row => row.data.date <= '2026-10-30');
  assert.deepEqual(first.map(row => row.data.date), ['2026-10-28']);
});

test('v2 reminder projection requires the owner, current common plan and complete rolling range', async () => {
  const f = await fixture(); const m = model(f);
  const input = { model: m, userId: 'a', groupId, preferences, now };
  assert.throws(() => createV2ReminderRequests({ ...input, userId: 'b' }), /本人/u);
  assert.throws(() => createV2ReminderRequests({ ...input, groupId: 'other' }), /本人/u);
  assert.throws(() => createV2ReminderRequests({ ...input, model: { ...m, plan: { ...m.plan, range: { ...range, through: '2026-11-01' } } } }), /予定期間/u);
  assert.deepEqual(createV2ReminderRequests({ ...input, preferences: { ...preferences, enabled: false } }).requests, []);
  const personal = buildV2PersonalPlan(m.plan, { viewerUserId: 'b', settings: { frequencyMode: 'standard', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 } }, now: now.getTime() });
  assert.throws(() => createV2ReminderRequests({ ...input, personal }), /本人の推奨日/u);
});

test('v2 reminder preferences reject coercion, extra fields, malformed times and unsafe notification scope IDs', () => {
  for (const bad of [{ ...preferences, enabled: 'true' }, { ...preferences, hour: 24 }, { ...preferences, minute: -1 }, { ...preferences, hour: NaN }, { ...preferences, extra: true }]) assert.throws(() => validateV2ReminderPreferences(bad));
  assert.throws(() => v2NotificationPrefix('../a', groupId));
});

test('v2 notification routing rejects missing/foreign/departed bindings and keeps personal and v1 routes intact', () => {
  const groups = [{ userId: 'a', groupId, status: 'active' }, { userId: 'b', groupId, status: 'active' }];
  const data = { kind: 'v2-housework-digest', workspace: v2NativeWorkspaceNamespace('a', groupId) };
  assert.deepEqual(notificationWorkspace(data, 'a', groups[0]), { userId: 'a', groupId });
  assert.equal(notificationWorkspace(data, 'b', groups[0]), undefined);
  assert.equal(notificationWorkspace(data, null, groups[0]), undefined);
  assert.equal(notificationWorkspace(data, 'a', { ...groups[0], status: 'removed' }), undefined);
  assert.equal(notificationWorkspace({ kind: data.kind }, 'a', groups[0]), undefined);
  assert.equal(notificationWorkspace({ kind: 'daily-housework-digest' }, 'a', groups[0]), null);
  assert.deepEqual(notificationWorkspace({ kind: 'daily-housework-digest', workspace: sharedGoogleNamespace('a', groupId) }, 'a', groups[0]), { userId: 'a', groupId });
});
