import type { LocalNotificationGateway } from '../../notifications/contracts';
import { reconcileLocalNotifications } from '../../notifications/reconcile-local-notifications.ts';
import type { NotificationReconciliationResult } from '../../notifications/reconcile-local-notifications.ts';
import type { V2ReminderStore, V2ReminderControl } from '../../../platform/storage/sharing-v2-reminders';
import type { V2GroupScreenModel } from './controller';
import type { V2PersonalPlan } from './personal-plan';
import { createV2ReminderRequests } from './reminders.ts';
import { v2NotificationPrefix } from './native-identity.ts';

export type V2ReminderModel = V2GroupScreenModel & { personal?: V2PersonalPlan };

class ReminderChanged extends Error {}
const sameControl = (a: V2ReminderControl, b: V2ReminderControl) => a.revision === b.revision && a.groupRevision === b.groupRevision;
export function createV2ReminderRuntime(input: { userId: string; groupId: string; store: V2ReminderStore; gateway: LocalNotificationGateway;
  readModel(now: Date): Promise<V2ReminderModel>; assertAccess(): void | Promise<void>; now?: () => Date; budgetNow?: () => number;
  afterSynchronize?: (remainingMs: number) => Promise<void> }) {
  let running: Promise<{ skippedDates: string[]; reservations: NotificationReconciliationResult }> | null = null; let requested = false;
  const elapsed = input.budgetNow ?? Date.now; let deadline = 0;
  const prefix = v2NotificationPrefix(input.userId, input.groupId);
  async function execute() {
    const budget = () => { if (elapsed() >= deadline) throw new Error('共有通知の更新は次回の同期で続けます。'); };
    for (let pass = 0; pass < 3; pass++) {
      requested = false; budget(); await input.assertAccess(); const before = await input.store.read(); budget();
      const model = before.preferences.enabled ? await input.readModel((input.now ?? (() => new Date()))()) : null;
      const after = await input.store.read(); budget(); await input.assertAccess();
      if (!sameControl(before, after)) continue;
      const planned = model ? createV2ReminderRequests({ model, userId: input.userId, groupId: input.groupId,
        preferences: before.preferences, personal: model.personal, now: (input.now ?? (() => new Date()))() }) : { requests: [], skippedDates: [] };
      let reservations: NotificationReconciliationResult;
      try {
        reservations = await reconcileLocalNotifications(input.gateway, { prefix, enabled: before.preferences.enabled, desired: planned.requests,
          assertCurrent: async () => { budget(); await input.assertAccess(); if (!sameControl(before, await input.store.read())) throw new ReminderChanged(); budget(); } });
      } catch (error) { if (error instanceof ReminderChanged) continue; throw error; }
      const result = { skippedDates: planned.skippedDates, reservations };
      budget(); await input.afterSynchronize?.(Math.max(1, deadline - elapsed())); budget();
      if (!requested) return result;
    }
    throw new Error('共有予定が更新されています。通知は次回の同期で更新します。');
  }
  return {
    store: input.store,
    async requestPermission() { await input.assertAccess(); const permitted = await input.gateway.requestPermission(); await input.assertAccess(); return permitted; },
    async permissionStatus() { await input.assertAccess(); const permitted = await input.gateway.hasPermission(); await input.assertAccess(); return permitted; },
    synchronize(budgetMs = 15_000) {
      if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 60_000) return Promise.reject(new Error('通知更新の時間枠を確認してください。'));
      if (running) { requested = true; deadline = Math.min(deadline, elapsed() + budgetMs); return running; }
      deadline = elapsed() + budgetMs;
      const pending = execute(); running = pending;
      void pending.finally(() => { if (running === pending) running = null; }).catch(() => undefined); return pending;
    },
    /** Removing scheduled reminders needs no group data or authority to edit the group. */
    clear: () => reconcileLocalNotifications(input.gateway, { prefix, enabled: false, desired: [] }),
  };
}
export type V2ReminderRuntime = ReturnType<typeof createV2ReminderRuntime>;
