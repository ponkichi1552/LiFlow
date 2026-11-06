import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '@/domain/shared/types';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { publishTodayWidgetSnapshot } from '@/features/widgets/publish-today-widget-snapshot';
import { syncDailyHouseworkDigest } from '@/features/notifications/daily-housework-digest';
import { expoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';
import { refreshPlannerFromWidget } from '@/platform/widgets/refresh-planner-from-widget';

/** Refresh the same widget and digest outputs used after ordinary planner completion. */
export async function refreshPlannerAfterGoogleImport(database: SQLiteDatabase, _today: LocalDate, _savedSnapshot?: PlannerSnapshot): Promise<void> {
  const { snapshot, canPublishWidget } = await refreshPlannerFromWidget(database, [], { publish: false });
  if (snapshot.sharing) return;
  const results = await Promise.allSettled([
    canPublishWidget ? publishTodayWidgetSnapshot(snapshot) : Promise.resolve(),
    syncDailyHouseworkDigest(expoLocalNotificationGateway, snapshot),
  ]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
