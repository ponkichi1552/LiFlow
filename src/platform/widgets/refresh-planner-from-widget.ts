import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import { createWidgetCompletionSync } from '@/features/widgets/widget-completion-sync';
import { publishTodayWidgetSnapshot } from '@/features/widgets/publish-today-widget-snapshot';
import { commitWidgetCompletionOperation, completeChore, loadPlannerSnapshot, readCachedPlannerSnapshot } from '@/platform/storage/repository';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { expoWidgetGateway, readIOSWidgetCompletionBatch, readIOSWidgetCompletionOperations, acknowledgeIOSWidgetCompletionOperations } from '@/platform/widgets/expo-widget-gateway';
import { readNativeWidgetCompletionOperations, quarantineWidgetCompletionInput } from '../storage/widget-completion-intents';

const synchronizers = new WeakMap<SQLiteDatabase, ReturnType<typeof createWidgetCompletionSync<PlannerSnapshot>>>();

export async function refreshPlannerFromWidget(database: SQLiteDatabase, _requestedIds: readonly string[] = [], options: { publish?: boolean; preferCached?: boolean } = {}) {
  const subscription = await import('../subscription/runtime');
  await subscription.assertSubscriptionAccess();
  let nativeFailed = false;
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    const scope = subscription.subscriptionRequired ? subscription.subscriptionSnapshot().userId : 'local-development';
    const assertAccess = async () => {
      await subscription.assertSubscriptionAccess();
      if (subscription.subscriptionRequired && subscription.subscriptionSnapshot().userId !== scope) throw new Error('ウィジェットのアカウントが変わりました。');
    };
    try {
      const acknowledged: string[] = [];
      const batch = Platform.OS === 'ios' && readIOSWidgetCompletionBatch ? await readIOSWidgetCompletionBatch() : null;
      for (const raw of batch?.rejected ?? []) {
        await assertAccess(); await quarantineWidgetCompletionInput(database, raw, 'invalidInput');
        const id = (raw as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && id.startsWith('completion-intent.') && id.length <= 80) acknowledged.push(id);
      }
      const operations = Platform.OS === 'android' ? await readNativeWidgetCompletionOperations(database) : batch?.operations ?? await readIOSWidgetCompletionOperations();
      for (const operation of operations) {
        if (operation.accountScope !== scope) continue;
        try {
          const result = await commitWidgetCompletionOperation(database, operation, assertAccess);
          if (result === 'targetChanged') await quarantineWidgetCompletionInput(database, operation, 'targetChanged');
          if (Platform.OS === 'ios') acknowledged.push(operation.id);
        } catch { await assertAccess(); nativeFailed = true; }
      }
      if (Platform.OS === 'ios' && acknowledged.length) { await assertAccess(); await acknowledgeIOSWidgetCompletionOperations([...new Set(acknowledged)]); }
    } catch { nativeFailed = true; }
  }
  let synchronize = synchronizers.get(database);
  if (!synchronize) {
    synchronize = createWidgetCompletionSync({
      load: async (preferCached) => (preferCached ? readCachedPlannerSnapshot(database) : null) ?? loadPlannerSnapshot(database),
      pendingIds: () => expoWidgetGateway.getPendingWidgetCompletionIds(),
      complete: async (entry) => {
        const before = subscription.subscriptionRequired ? subscription.subscriptionSnapshot().userId : undefined;
        return completeChore(database, entry, undefined, 'widget', async () => {
          await subscription.assertSubscriptionAccess();
          if (subscription.subscriptionRequired && subscription.subscriptionSnapshot().userId !== before) throw new Error('ウィジェットのアカウントが変わりました。');
        });
      },
      publish: publishTodayWidgetSnapshot,
    });
    synchronizers.set(database, synchronize);
  }
  // Both platforms recover durable inputs. Older ID-only iOS inputs are still recovered from saved props, never a transient event.
  const result = await synchronize([], { ...options, ignorePending: nativeFailed, publish: nativeFailed ? false : options.publish });
  return { ...result, canPublishWidget: result.canPublishWidget && !nativeFailed };
}
