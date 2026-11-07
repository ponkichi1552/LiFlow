import type { ISODateTime, LocalDate } from '@/domain/shared/types';
import type { ChoreScheduleEntry } from '@/domain/chores/types';
import type { WidgetCompletionOperation } from './completion-operation';

export interface TodayWidgetChore {
  id: string;
  name: string;
  completed: boolean;
  /** Frozen native input target, never displayed. */
  entry?: ChoreScheduleEntry;
  completionGeneration?: number;
}

export interface NextChoreWidgetSnapshot {
  chores: readonly TodayWidgetChore[];
  remainingCount: number;
  updatedAt: ISODateTime;
  displayDate?: LocalDate;
  displayTimeZone?: string;
  contentUntil?: number;
  householdCreatedAt?: string;
}

export interface NextChoreWidgetDisplayProps {
  chores: readonly TodayWidgetChore[];
  pendingWidgetCompletionIds: readonly string[];
  remainingCount: number;
  updatedAt: ISODateTime;
  accessUntil?: number;
  subscriptionLocked?: boolean;
  displayDate?: LocalDate;
  displayTimeZone?: string;
  contentUntil?: number;
  contentStale?: boolean;
  /** Exact account and native acceptance boundaries; no token or entitlement proof is exposed. */
  widgetAccountScope?: string;
  subscriptionEnforced?: boolean;
  publishedAtMs?: number;
  householdCreatedAt?: string;
  nativeWidgetInputVersion?: number;
  nativeWidgetCompletionOperations?: readonly WidgetCompletionOperation[];
}

export interface WidgetGateway {
  updateNextChore(snapshot: NextChoreWidgetSnapshot): void | Promise<void>;
  getPendingWidgetCompletionIds(): Promise<readonly string[]>;
}
