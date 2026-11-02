import { AndroidImportance, cancelScheduledNotificationAsync, dismissNotificationAsync, getPresentedNotificationsAsync, scheduleNotificationAsync, setNotificationChannelAsync } from 'expo-notifications';
import { Platform } from 'react-native';
import { withLocalNotificationOperation } from '../../features/notifications/reconcile-local-notifications';
import { expoLocalNotificationGateway } from '../notifications/expo-local-notification-gateway';
import { v2NativeWorkspaceNamespace } from '../../features/sharing/v2/native-identity';
import { parseLocalDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';

export interface V2ImmediateNotice { key: string; title: string; body: string; count: number; date?: LocalDate }
/** The same native queue and capacity boundary is used for all immediate v2 notices. */
export function createV2ImmediateNoticePresenter(scope: { userId: string; groupId: string }, config: {
  prefix: string; kind: 'v2-housework-completed'; channelId: string; channelName: string;
}) {
  const namespace = v2NativeWorkspaceNamespace(scope.userId, scope.groupId);
  return async (notice: V2ImmediateNotice, assertCurrent: () => Promise<void>, beforePresent?: () => Promise<boolean>) => {
    const captured = { ...notice };
    if (!captured.key.startsWith(config.prefix) || !/^[a-f0-9]{64}$/u.test(captured.key.slice(config.prefix.length))
      || !Number.isSafeInteger(captured.count) || captured.count < 1) throw new Error('端末通知の対象を確認してください。');
    if (captured.date) parseLocalDate(captured.date);
    return withLocalNotificationOperation(expoLocalNotificationGateway, async () => {
      await assertCurrent();
      const deadline = await expoLocalNotificationGateway.schedulingDeadline?.() ?? Infinity;
      if (Date.now() >= deadline) return;
      const capacity = expoLocalNotificationGateway.maximumScheduledRequests;
      if (capacity !== undefined && (await expoLocalNotificationGateway.getScheduledRequests()).length >= capacity) throw new Error('端末の通知予約上限のため、通知を省略しました。');
      await assertCurrent();
      if (Platform.OS === 'android') await setNotificationChannelAsync(config.channelId, { name: config.channelName, importance: AndroidImportance.DEFAULT });
      await assertCurrent();
      if (beforePresent && !await beforePresent()) return;
      await assertCurrent();
      // Channel setup and the final state review can outlive the entitlement.
      const currentDeadline = await expoLocalNotificationGateway.schedulingDeadline?.() ?? Infinity;
      await assertCurrent();
      if (Date.now() >= Math.min(deadline, currentDeadline)) return;
      await scheduleNotificationAsync({ identifier: captured.key, content: { title: captured.title, body: captured.body,
        data: { kind: config.kind, workspace: namespace, count: captured.count, ...(captured.date ? { date: captured.date } : {}) }, color: '#4AADE0' },
        trigger: Platform.OS === 'android' ? { channelId: config.channelId } : null });
    });
  };
}

export function clearV2ImmediateNotices(matches: (id: string) => boolean, assertCurrent: () => void | Promise<void>) {
  return withLocalNotificationOperation(expoLocalNotificationGateway, async () => {
    await assertCurrent(); const pending = await expoLocalNotificationGateway.getScheduledRequests(); await assertCurrent();
    for (const notification of pending) if (matches(notification.key)) { await assertCurrent(); await cancelScheduledNotificationAsync(notification.key); }
    const presented = await getPresentedNotificationsAsync(); await assertCurrent();
    for (const notification of [...presented]) if (matches(notification.request.identifier)) { await assertCurrent(); await dismissNotificationAsync(notification.request.identifier); }
  });
}
