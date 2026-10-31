import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeModule } from './helpers/native-module.mjs';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { applyReceivedSharedFacts, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
import * as stores from '../src/platform/storage/sharing-v2-completion-notices.ts';
import * as runtimes from '../src/features/sharing/v2/completion-notice-runtime.ts';
import * as projection from '../src/features/sharing/v2/completion-notices.ts';
import * as identities from '../src/features/sharing/v2/native-identity.ts';
import { notificationWorkspace, isPlannerNotification } from '../src/features/notifications/workspace-response.ts';
import { readFileSync } from 'node:fs';
import { screenHarness } from './helpers/screen-harness.mjs';
import * as notificationQueue from '../src/features/notifications/reconcile-local-notifications.ts';
import * as localDate from '../src/domain/scheduling/local-date.ts';

async function receive(d, facts) { const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts))); }
async function setup(platform) {
  const f = await fixture(); const d = await f.device(); const member = await f.device('member', f.member); await d.repository.commit(seeds());
  let number = 0;
  const a = createV2GroupController(d.repository, { now, makeId: () => `notice-enable-${++number}`, sync: async () => {} });
  const b = createV2GroupController(member.repository, { now, makeId: () => 'native-notice-completion', sync: async () => {} });
  const calls = []; let active = true; let channelHook; const presented = []; const pending = [];
  const gateway = { maximumScheduledRequests: platform === 'ios' ? 60 : undefined,
    getScheduledRequests: async () => { calls.push('pending-read'); return [...pending]; } };
  const assertAccess = () => { if (!active) throw new Error('account changed'); };
  const mocks = {
    'react-native': { Platform: { OS: platform } }, '../storage/sharing-v2-completion-notices': stores,
    '../../features/sharing/v2/completion-notice-runtime': runtimes, '../../features/sharing/v2/completion-notices': projection,
    '../../features/sharing/v2/native-identity': identities,
    '../../features/notifications/reconcile-local-notifications': notificationQueue,
    '../../domain/scheduling/local-date': localDate,
    '../notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: gateway },
    'expo-notifications': { AndroidImportance: { DEFAULT: 3 }, getPermissionsAsync: async () => { calls.push('permission'); return { granted: true }; },
      setNotificationChannelAsync: async (name, config) => { calls.push(['channel', name, config]); await channelHook?.(); },
      scheduleNotificationAsync: async request => { calls.push(['present', request]); presented.push({ request: { identifier: request.identifier } }); return request.identifier; },
      getPresentedNotificationsAsync: async () => presented, dismissNotificationAsync: async id => { calls.push(['dismiss', id]); presented.splice(presented.findIndex(row => row.request.identifier === id), 1); },
      cancelScheduledNotificationAsync: async id => { calls.push(['cancel-pending', id]); pending.splice(pending.findIndex(row => row.key === id), 1); },
    },
  };
  mocks['./v2-immediate-notices'] = loadNativeModule('src/platform/sharing/v2-immediate-notices.ts', mocks);
  const module = loadNativeModule('src/platform/sharing/v2-completion-notices.ts', mocks);
  const scope = { repository: d.repository, userId: 'owner', groupId, assertAccess };
  const runtime = module.createNativeV2CompletionNotices(scope);
  return { f, d, member, a, b, module, runtime, calls, presented, pending, gateway, scope, channel(work) { channelHook = work; }, stop() { active = false; },
    async enable() { await a.actions.patchGroupPolicy({ completionPushEnabled: true }); await runtime.synchronize(); calls.length = 0; },
    async complete() { await receive(member, await loadSharedFacts(d.database, groupId)); await b.actions.complete({ choreId: 'floor', anchorDate: '2026-10-27', subjectUserId: null }); await receive(d, await loadSharedFacts(member.database, groupId)); },
    close() { d.connection.close(); member.connection.close(); } };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} completion OS QA route rejects release before creating a presenter or requesting permission`, () => {
    const previous = globalThis.__DEV__; globalThis.__DEV__ = false; let created = 0;
    try {
      const screen = screenHarness('src/app/development/v2-completion-notice-preview.tsx', { platform, mocks: {
        '../../platform/sharing/v2-completion-notice-preview': { createV2CompletionNoticePreview() { created++; } },
      } }); assert.match(screen.text(), /開発ビルド専用/u); assert.equal(created, 0);
    } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
  });
  test(`${platform} Native completion notices use noninteractive permission and platform-correct immediate delivery only after opt-in`, async () => {
    const h = await setup(platform); try {
      await h.runtime.synchronize(); assert.deepEqual(h.calls, []); await h.enable(); await h.complete(); await h.runtime.synchronize();
      const request = h.calls.find(call => call[0] === 'present')[1];
      assert.deepEqual(request.trigger, platform === 'android' ? { channelId: 'housework-completions' } : null);
      assert.equal(h.calls.filter(call => call[0] === 'channel').length, platform === 'android' ? 1 : 0);
      assert.deepEqual(Object.keys(request.content.data).sort(), ['count', 'kind', 'workspace']); assert.equal(request.content.data.kind, 'v2-housework-completed');
      assert.deepEqual(notificationWorkspace(request.content.data, 'owner', { userId: 'owner', groupId, status: 'active' }), { userId: 'owner', groupId });
      assert.equal(notificationWorkspace(request.content.data, 'member', { userId: 'owner', groupId, status: 'active' }), undefined);
      await h.module.createNativeV2CompletionNotices(h.scope).synchronize(); assert.equal(h.calls.filter(call => call[0] === 'present').length, 1);
    } finally { h.close(); }
  });
  test(`${platform} Native completion cleanup removes only departed owner scopes and preserves personal v1 and valid notifications`, async () => {
    const h = await setup(platform); try {
      const own = projection.v2CompletionNoticePrefix('owner', groupId) + 'old'; const stale = projection.v2CompletionNoticePrefix('previous', groupId) + 'old';
      const keep = ['personal-message', 'liflow-group-digest:old', own];
      h.presented.push(...[...keep, stale].map(identifier => ({ request: { identifier } })));
      await h.module.clearInactiveV2CompletionNotices([{ userId: 'owner', groupId }], h.scope.assertAccess);
      assert.deepEqual(h.presented.map(row => row.request.identifier), keep);
      await h.module.clearV2CompletionNoticesForScope('owner', groupId); assert.deepEqual(h.presented.map(row => row.request.identifier), keep.slice(0, 2));
      h.stop(); await assert.rejects(h.module.clearInactiveV2CompletionNotices([], h.scope.assertAccess), /account changed/u);
      assert.equal(h.presented.length, 2);
    } finally { h.close(); }
  });
  test(`${platform} immediate completion presentation waits for the existing notification queue and snapshots its input`, async () => {
    const h = await setup(platform); let release; let entered; const ready = new Promise(resolve => { entered = resolve; });
    try {
      const gate = new Promise(resolve => { release = resolve; }); const previous = notificationQueue.withLocalNotificationOperation(h.gateway, async () => { entered(); await gate; }); await ready;
      const notice = { key: projection.v2CompletionNoticePrefix('owner', groupId) + 'a'.repeat(64), title: '確認済みの題名', body: '確認済みの本文', count: 1 };
      const queued = h.module.createV2CompletionNoticePresenter(h.scope)(notice, async () => h.scope.assertAccess()); notice.body = '待機中の書換え';
      await new Promise(setImmediate); assert.deepEqual(h.calls, [], 'OS access must wait behind the existing planner operation');
      release(); await previous; await queued;
      assert.equal(h.calls.find(call => call[0] === 'present')[1].content.body, '確認済みの本文');
    } finally { release?.(); h.close(); }
  });
  test(`${platform} a revoked queued completion cannot reach native delivery after waiting for another notification operation`, async () => {
    const h = await setup(platform); let release; let entered; const ready = new Promise(resolve => { entered = resolve; });
    try {
      const gate = new Promise(resolve => { release = resolve; }); const previous = notificationQueue.withLocalNotificationOperation(h.gateway, async () => { entered(); await gate; }); await ready;
      const work = h.module.createV2CompletionNoticePresenter(h.scope)({ key: projection.v2CompletionNoticePrefix('owner', groupId) + 'b'.repeat(64), title: '', body: '', count: 1 }, async () => h.scope.assertAccess());
      const rejected = assert.rejects(work, /account changed/u); h.stop(); release(); await previous; await rejected; assert.deepEqual(h.calls, []);
    } finally { release?.(); h.close(); }
  });
  test(`${platform} completion cleanup cancels an immediate request still pending before dismissing every obsolete displayed notice`, async () => {
    const h = await setup(platform); try {
      const prefix = projection.v2CompletionNoticePrefix('previous', groupId); h.pending.push({ key: prefix + 'pending' }, { key: 'personal-future' });
      h.presented.push(...[prefix + 'one', prefix + 'two', 'personal-presented'].map(identifier => ({ request: { identifier } })));
      await h.module.clearInactiveV2CompletionNotices([], h.scope.assertAccess);
      assert.deepEqual(h.pending.map(row => row.key), ['personal-future']); assert.deepEqual(h.presented.map(row => row.request.identifier), ['personal-presented']);
      assert.ok(h.calls.findIndex(call => call[0] === 'cancel-pending') < h.calls.findIndex(call => call[0] === 'dismiss'));
    } finally { h.close(); }
  });
  test(`${platform} development OS audit notices have their own guarded namespace without weakening cleanup of an unregistered normal workspace`, async () => {
    const h = await setup(platform); const previous = globalThis.__DEV__; globalThis.__DEV__ = true;
    try {
      const qaPrefix = h.module.developmentV2CompletionNoticePrefix(h.scope); assert.ok(qaPrefix.startsWith('liflow-qa-v2-completed:'));
      const normal = projection.v2CompletionNoticePrefix('owner', groupId) + 'normal';
      h.presented.push({ request: { identifier: normal } }, { request: { identifier: qaPrefix + 'audit' } });
      await h.module.clearInactiveV2CompletionNotices([], h.scope.assertAccess);
      assert.deepEqual(h.presented.map(row => row.request.identifier), [qaPrefix + 'audit']);
      globalThis.__DEV__ = false; assert.throws(() => h.module.createV2CompletionNoticePresenter(h.scope, 'development-os-audit'), /開発ビルド専用/u);
    } finally { h.close(); if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
  });
}
test('iOS immediate completion delivery preserves a full app-wide reservation without evicting another scope', async () => {
  const h = await setup('ios'); try {
    h.pending.push(...Array.from({ length: 60 }, (_, index) => ({ key: `other-scope-${index}` })));
    const notice = { key: projection.v2CompletionNoticePrefix('owner', groupId) + 'c'.repeat(64), title: '', body: '', count: 1 };
    await assert.rejects(h.module.createV2CompletionNoticePresenter(h.scope)(notice, async () => {}), /通知予約上限/u);
    assert.equal(h.pending.length, 60); assert.equal(h.calls.filter(call => ['present', 'dismiss', 'cancel-pending'].includes(call[0])).length, 0);
  } finally { h.close(); }
});
test('completion OS QA service rejects release before reading OS permissions or presented notifications', () => {
  const previous = globalThis.__DEV__; globalThis.__DEV__ = false;
  try {
    const source = readFileSync(new URL('../src/platform/sharing/v2-completion-notice-preview.ts', import.meta.url), 'utf8');
    const mocks = Object.fromEntries([...source.matchAll(/from ['"]([^'"]+)['"]/gu)].map(match => [match[1], {}]));
    const module = loadNativeModule('src/platform/sharing/v2-completion-notice-preview.ts', mocks);
    assert.throws(module.createV2CompletionNoticePreview, /開発ビルド専用/u);
  } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
});
test('Android rechecks the completion setting after creating a channel before any immediate OS request', async () => {
  const h = await setup('android'); try {
    await h.enable(); await h.complete(); h.channel(() => h.a.actions.patchGroupPolicy({ completionPushEnabled: false }));
    await assert.rejects(h.runtime.synchronize(), /通知前に完了状態が変わり/u); assert.equal(h.calls.filter(call => call[0] === 'present').length, 0);
  } finally { h.close(); }
});
test('notification metadata has one shared kind recognizer for completion and reminders without changing personal or v1 routing', () => {
  for (const kind of ['v2-housework-completed', 'v2-housework-digest', 'daily-housework-digest']) assert.equal(isPlannerNotification({ kind }), true);
  for (const value of [null, {}, { kind: 'message' }]) assert.equal(isPlannerNotification(value), false);
  assert.equal(notificationWorkspace({ kind: 'v2-housework-completed' }, 'owner', null), undefined);
  assert.equal(notificationWorkspace({ kind: 'daily-housework-digest' }, 'owner', null), null);
});
