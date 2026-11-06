import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import { createWidgetCompletionSync } from '@/features/widgets/widget-completion-sync';
import { publishTodayWidgetSnapshot } from '@/features/widgets/publish-today-widget-snapshot';
import { commitWidgetCompletionOperation, completeChore, loadPlannerSnapshot, readCachedPlannerSnapshot } from '@/platform/storage/repository';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { expoWidgetGateway, readIOSWidgetCompletionOperations, acknowledgeIOSWidgetCompletionOperations } from '@/platform/widgets/expo-widget-gateway';
import { readNativeWidgetCompletionOperations } from '../storage/widget-completion-intents';

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
      const operations = Platform.OS === 'android' ? await readNativeWidgetCompletionOperations(database) : await readIOSWidgetCompletionOperations();
      for (const operation of operations) {
        if (operation.accountScope !== scope) continue;
        await commitWidgetCompletionOperation(database, operation, assertAccess);
        if (Platform.OS === 'ios') await acknowledgeIOSWidgetCompletionOperations([operation.id]);
      }
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
