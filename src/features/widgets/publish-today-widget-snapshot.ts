import { localDateFromDate } from '@/domain/scheduling/local-date';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { createTodayWidgetSnapshot } from '@/features/widgets/today-widget-snapshot';
import { expoWidgetGateway } from '@/platform/widgets/expo-widget-gateway';
import { sharedLocalDate } from '../sharing/group-clock.ts';

export async function publishTodayWidgetSnapshot(snapshot: PlannerSnapshot): Promise<void> {
  const now = new Date();
  const widget = createTodayWidgetSnapshot(
    snapshot.scheduleEntries,
    snapshot.chores,
    snapshot.completions,
    snapshot.timeZone ? sharedLocalDate(now, snapshot.timeZone) : localDateFromDate(now),
    now.toISOString(), snapshot.timeZone,
  );
  widget.householdCreatedAt = snapshot.household?.createdAt;
  widget.chores = widget.chores.map(chore => ({ ...chore, entry: snapshot.scheduleEntries.find(entry => entry.id === chore.id),
    completionGeneration: snapshot.widgetCompletionGenerations?.[chore.id] ?? 0 }));
  // The refresh controller keeps the screen usable and retries an unfinished output.
  await expoWidgetGateway.updateNextChore(widget);
}
