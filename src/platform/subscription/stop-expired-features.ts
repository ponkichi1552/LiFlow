import { lockSubscriptionWidget } from '../widgets/expo-widget-gateway';
import { subscriptionSnapshot } from './runtime';
import { expoLocalNotificationGateway } from '../notifications/expo-local-notification-gateway';
import { withLocalNotificationOperation } from '../../features/notifications/reconcile-local-notifications';
let running: Promise<void> | undefined;
let runningState: ReturnType<typeof subscriptionSnapshot> | undefined;
export function stopExpiredSubscriptionFeatures(): Promise<void> {
  const requested = subscriptionSnapshot();
  if (running) return runningState === requested ? running : running.catch(() => undefined).then(() => {
    if (subscriptionSnapshot() === requested) return stopExpiredSubscriptionFeatures();
  });
  const work = (async () => {
    const before = subscriptionSnapshot();
    const current = () => subscriptionSnapshot() === before && before.phase !== 'active' && before.phase !== 'checking';
    if (!current()) return;
    const failures: unknown[] = [];
    const notifications = withLocalNotificationOperation(expoLocalNotificationGateway, async () => {
      if (!current()) return;
      let pending;
      try { pending = await expoLocalNotificationGateway.getScheduledRequests(); }
      catch (error) { failures.push(error); return; }
      for (const notification of pending) {
        if (!current()) return;
        try { await expoLocalNotificationGateway.cancel(notification.key); }
        catch (error) { failures.push(error); }
      }
    });
    // The two outputs fail independently; a failed notification must not leave the widget open.
    const widget = current() ? lockSubscriptionWidget().catch(error => { failures.push(error); }) : Promise.resolve();
    await Promise.all([notifications, widget]);
    if (current() && failures.length) throw failures[0];
  })();
  running = work; runningState = requested;
  void work.finally(() => { if (running === work) { running = undefined; runningState = undefined; } }).catch(() => undefined); return work;
}
