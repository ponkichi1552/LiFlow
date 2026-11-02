import { getAllScheduledNotificationsAsync, cancelScheduledNotificationAsync } from 'expo-notifications';
import { lockSubscriptionWidget } from '../widgets/expo-widget-gateway';
import { subscriptionSnapshot } from './runtime';
let running: Promise<void> | undefined;
export function stopExpiredSubscriptionFeatures(): Promise<void> {
  if (running) return running;
  const work = (async () => {
    const pending = await getAllScheduledNotificationsAsync();
    if (subscriptionSnapshot().phase === 'active') return;
    for (const notification of pending) {
      if (subscriptionSnapshot().phase === 'active') return;
      await cancelScheduledNotificationAsync(notification.identifier);
    }
    if (subscriptionSnapshot().phase !== 'active') await lockSubscriptionWidget();
  })();
  running = work; void work.finally(() => { if (running === work) running = undefined; }).catch(() => undefined); return work;
}
