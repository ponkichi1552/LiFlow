import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as tasks from '../src/domain/scheduling/date-tasks.ts';
import * as dates from '../src/domain/scheduling/local-date.ts';
import * as clock from '../src/features/sharing/group-clock.ts';
import * as reconciliation from '../src/features/notifications/reconcile-local-notifications.ts';
import * as names from '../src/domain/chores/occurrence-name.ts';
const snapshot = () => ({ timeZone: 'Asia/Tokyo', chores: [{ id: 'clean', name: '掃除', enabled: true }], completions: [],
  settings: { notificationHour: 9, notificationMinute: 0, notificationsEnabled: true, setupCompleted: true },
  scheduleEntries: [{ id: 'round', choreId: 'clean', householdId: 'local-household', cycleBaseDate: '2026-11-09', suggestedDate: '2026-11-09',
    windowStart: '2026-11-07', windowEnd: '2026-11-09', status: 'scheduled', assignedMemberIds: [] }] });

test('notification reconciliation resolves zoned fire times only for dates with actual reminder content', t => {
  let resolutions = 0;
  const { createDailyHouseworkDigestRequests } = loadNativeModule('src/features/notifications/daily-housework-digest.ts', {
    '@/domain/scheduling/date-tasks': tasks, '@/domain/scheduling/local-date': dates,
    '../sharing/group-clock': { ...clock, sharedDateAtTime: (...args) => { resolutions++; return clock.sharedDateAtTime(...args); } },
    './reconcile-local-notifications': reconciliation, '../../domain/chores/occurrence-name': names,
  });
  const input = snapshot(); const now = new Date('2026-11-06T23:00:00Z');
  const result = createDailyHouseworkDigestRequests(input, now);
  assert.deepEqual(result.map(row => row.key), ['housework-digest:2026-11-07', 'housework-digest:2026-11-09', 'housework-digest:2026-11-10']);
  t.diagnostic(`non-empty fire-time resolutions: ${resolutions}`); assert.equal(resolutions, 3);
  resolutions = 0; input.scheduleEntries = []; assert.deepEqual(createDailyHouseworkDigestRequests(input, now), []); assert.equal(resolutions, 0);
});

test('a verified access deadline changing during replacement cancels the old unauthorized reminder without sending a new one', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-07T00:00:00Z') });
  let sent = 0, checks = 0;
  const { ExpoLocalNotificationGateway } = loadNativeModule('src/platform/notifications/expo-local-notification-gateway.ts', {
    'react-native': { Platform: { OS: 'ios' } }, 'expo-notifications': { SchedulableTriggerInputTypes: { DATE: 'date' }, scheduleNotificationAsync: async () => { sent++; return 'notice'; } },
  });
  const old = { key: 'reminder.round', title: '家事', body: '古い予約', fireAt: '2026-11-07T11:00:00Z' };
  const saved = new Map([[old.key, old]]); const gateway = new ExpoLocalNotificationGateway();
  gateway.getScheduledRequests = async () => [...saved.values()]; gateway.hasPermission = async () => true;
  gateway.schedulingDeadline = async () => ++checks === 1 ? Infinity : 0;
  gateway.cancel = async key => { saved.delete(key); };
  const result = await reconciliation.reconcileLocalNotifications(gateway, { prefix: 'reminder.', enabled: true,
    desired: [{ ...old, body: '変更後', fireAt: '2026-11-07T12:00:00Z' }] });
  assert.equal(sent, 0); assert.equal(saved.size, 0); assert.equal(result.cancelled, 1); assert.equal(result.deadlineExcluded, 1); assert.equal(result.failed, 0);
});
