import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileLocalNotifications } from '../src/features/notifications/reconcile-local-notifications.ts';
import { ExpiredNotificationRequestError } from '../src/features/notifications/expired-request.ts';

test('audit50 a reminder expiring in the native queue releases its slot for the next future reminder', async () => {
  const expired = { key: 'reminder.early', title: 'early', body: '', fireAt: '2026-11-07T01:00:00Z' };
  const future = { ...expired, key: 'reminder.later', title: 'later', fireAt: '2026-11-08T01:00:00Z' };
  const stored = new Map([[future.key, future]]); const calls = [];
  const gateway = { maximumScheduledRequests: 1, hasPermission: async () => true,
    getScheduledRequests: async () => [...stored.values()], cancel: async key => { calls.push(['cancel', key]); stored.delete(key); },
    schedule: async request => { calls.push(['schedule', request.key]); if (request.key === expired.key) throw new ExpiredNotificationRequestError(); stored.set(request.key, request); return request.key; } };
  const result = await reconcileLocalNotifications(gateway, { prefix: 'reminder.', enabled: true, desired: [future, expired] });
  assert.deepEqual([...stored.keys()], [future.key]);
  assert.equal(result.scheduled, 1); assert.equal(result.unchanged, 0);
  assert.equal(result.deadlineExcluded, 1); assert.equal(result.capacityExcluded, 0);
  assert.deepEqual(calls, [['cancel', future.key], ['schedule', expired.key], ['schedule', future.key]]);
});
