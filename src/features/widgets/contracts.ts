import type { ISODateTime } from '@/domain/shared/types';

export interface TodayWidgetChore {
  id: string;
  name: string;
  completed: boolean;
}

export interface NextChoreWidgetSnapshot {
  chores: readonly TodayWidgetChore[];
  remainingCount: number;
  updatedAt: ISODateTime;
}

export interface NextChoreWidgetDisplayProps {
  chores: readonly TodayWidgetChore[];
  pendingWidgetCompletionIds: readonly string[];
  remainingCount: number;
  updatedAt: ISODateTime;
  accessUntil?: number;
  subscriptionLocked?: boolean;
}

export interface WidgetGateway {
  updateNextChore(snapshot: NextChoreWidgetSnapshot): void;
  getPendingWidgetCompletionIds(): Promise<readonly string[]>;
}
