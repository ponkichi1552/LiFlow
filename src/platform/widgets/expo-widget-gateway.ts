import { Platform } from 'react-native';

import type { NextChoreWidgetDisplayProps, NextChoreWidgetSnapshot, WidgetGateway } from '@/features/widgets/contracts';
import NextChoreWidget from '@/platform/widgets/NextChoreWidget';
import { traceStartup } from '@/platform/diagnostics/startup-timing';
import { subscriptionRequired, subscriptionAccessDeadline, subscriptionSnapshot } from '../subscription/runtime';
import { validateWidgetCompletionOperation } from '../../features/widgets/completion-operation';
import type { WidgetCompletionOperation } from '../../features/widgets/completion-operation';

let publishedSignature: string | undefined;
let revision = 0;
let queue: Promise<unknown> = Promise.resolve();
function ordered<T>(work: () => Promise<T>): Promise<T> {
  const pending = queue.then(work, work);
  queue = pending.then(() => undefined, () => undefined); return pending;
}
function pendingIds(entries: Awaited<ReturnType<typeof NextChoreWidget.getTimeline>>) {
  const latest = entries.reduce<(typeof entries)[number] | null>((current, entry) => !current || entry.date > current.date ? entry : current, null);
  const currentEntries = subscriptionRequired ? entries.filter(entry => entry.props.updatedAt === latest?.props.updatedAt
    && entry.props.widgetAccountScope === subscriptionSnapshot().userId) : latest ? [latest] : [];
  return [...new Set(currentEntries.flatMap(entry => entry.props.pendingWidgetCompletionIds ?? []))];
}

export const expoWidgetGateway: WidgetGateway = {
  updateNextChore(snapshot: NextChoreWidgetSnapshot): Promise<void> {
    const captured = ++revision;
    const account = subscriptionRequired ? subscriptionSnapshot() : undefined;
    const owned = { ...snapshot, chores: snapshot.chores.map(chore => ({ ...chore })) };
    return ordered(async () => {
      if (captured !== revision || subscriptionRequired && subscriptionSnapshot() !== account) return;
      const deadline = subscriptionRequired ? await subscriptionAccessDeadline() : Infinity;
      if (captured !== revision || deadline <= Date.now() || subscriptionRequired && subscriptionSnapshot() !== account) return;
      const scope = subscriptionRequired ? account?.userId : 'local-development';
      if (!scope) return;
      const signature = JSON.stringify([owned.chores, owned.remainingCount, owned.displayDate, owned.displayTimeZone, owned.contentUntil, owned.householdCreatedAt, deadline, scope]);
      if (signature === publishedSignature) return;
      const props: NextChoreWidgetDisplayProps = { ...owned, pendingWidgetCompletionIds: [], remainingCount: Math.max(0, owned.remainingCount),
        widgetAccountScope: scope, subscriptionEnforced: subscriptionRequired, publishedAtMs: Date.now(),
        ...(subscriptionRequired ? { accessUntil: deadline } : {}) };
      if (Platform.OS === 'ios' && (subscriptionRequired || owned.contentUntil !== undefined)) {
        const boundaries = [...new Set([deadline, owned.contentUntil ?? Infinity].filter(at => Number.isFinite(at) && at > Date.now()))].sort((a, b) => a - b);
        const entries = [{ date: new Date(), props }, ...boundaries.map(at => ({ date: new Date(at), props: { ...props, chores: [], remainingCount: 0,
          ...(at >= deadline ? { subscriptionLocked: true } : {}), ...(at >= (owned.contentUntil ?? Infinity) ? { contentStale: true } : {}) } }))];
        NextChoreWidget.updateTimeline(entries);
      } else NextChoreWidget.updateSnapshot(props);
      publishedSignature = signature;
    });
  },

  async getPendingWidgetCompletionIds(): Promise<readonly string[]> {
    if (Platform.OS !== 'ios') return [];
    const ids = pendingIds(await traceStartup('widget.timeline', () => NextChoreWidget.getTimeline()));
    // The extension can change native props without changing the planner content.
    // Its pending actions still need the next snapshot to acknowledge them.
    if (ids.length > 0) publishedSignature = undefined;
    return ids;
  },
};

/** A callback is only a wake-up hint. The native journal is the authoritative accepted input. */
export async function readIOSWidgetCompletionOperations(): Promise<readonly WidgetCompletionOperation[]> {
  if (Platform.OS !== 'ios') return [];
  const entries = await NextChoreWidget.getTimeline();
  if (!entries.length) return [];
  if (entries.some(entry => entry.props.nativeWidgetInputVersion !== 1)) throw new Error('ウィジェットの更新が必要です。');
  const latest = entries.reduce((a, b) => a.date > b.date ? a : b);
  const operations = latest.props.nativeWidgetCompletionOperations;
  if (!Array.isArray(operations) || operations.length > 1000) throw new Error('ウィジェット操作を読み込めません。');
  const values = operations.map(validateWidgetCompletionOperation);
  if (new Set(values.map(value => value.id)).size !== values.length) throw new Error('ウィジェット操作が重複しています。');
  return values;
}

/** Broken rows are isolated individually; an unreadable whole journal is an error. */
export async function readIOSWidgetCompletionBatch() {
  const entries = await NextChoreWidget.getTimeline();
  if (!entries.length) return { operations: [] as WidgetCompletionOperation[], rejected: [] as unknown[] };
  if (entries.some(entry => entry.props.nativeWidgetInputVersion !== 1)) throw new Error('ウィジェットの更新が必要です。');
  const rows = entries.reduce((a,b) => a.date > b.date ? a : b).props.nativeWidgetCompletionOperations;
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error('ウィジェット操作を読み込めません。');
  const counts = new Map<unknown, number>(); for (const row of rows) counts.set(row?.id, (counts.get(row?.id) ?? 0) + 1);
  const operations: WidgetCompletionOperation[] = []; const rejected: unknown[] = [];
  for (const row of rows) try { const value = validateWidgetCompletionOperation(row); if (counts.get(value.id) !== 1) throw new Error('duplicate'); operations.push(value); }
  catch { rejected.push(row); }
  return { operations, rejected };
}

export function acknowledgeIOSWidgetCompletionOperations(ids: readonly string[]): Promise<void> {
  if (Platform.OS !== 'ios' || !ids.length) return Promise.resolve();
  return ordered(async () => {
    NextChoreWidget.updateSnapshot({ __liflowAckOnly: true, __liflowAcknowledgedOperationIds: [...ids] } as unknown as NextChoreWidgetDisplayProps);
  });
}

/** Expiry hides normal widget content while preserving actions already made before expiry. */
export function lockSubscriptionWidget(): Promise<void> {
  const captured = ++revision;
  const before = subscriptionSnapshot();
  return ordered(async () => {
    if (captured !== revision || before.phase === 'active') return;
    const entries = Platform.OS === 'ios' ? await NextChoreWidget.getTimeline() : [];
    if (captured !== revision || subscriptionSnapshot() !== before || subscriptionSnapshot().phase === 'active') return;
    NextChoreWidget.updateSnapshot({ chores: [], remainingCount: 0, pendingWidgetCompletionIds: pendingIds(entries),
      updatedAt: new Date().toISOString(), accessUntil: 0, subscriptionLocked: true });
    publishedSignature = undefined;
  });
}
