import { Platform } from 'react-native';

import type { NextChoreWidgetSnapshot, WidgetGateway } from '@/features/widgets/contracts';
import NextChoreWidget from '@/platform/widgets/NextChoreWidget';
import { traceStartup } from '@/platform/diagnostics/startup-timing';
import { subscriptionRequired, subscriptionAccessDeadline } from '../subscription/runtime';

let publishedSignature: string | undefined;
let revision = 0;

export const expoWidgetGateway: WidgetGateway = {
  updateNextChore(snapshot: NextChoreWidgetSnapshot): void {
    if (subscriptionRequired) {
      const captured = ++revision;
      void subscriptionAccessDeadline().then(deadline => {
        if (captured !== revision || deadline <= Date.now()) return;
        const signature = JSON.stringify([snapshot.chores, snapshot.remainingCount, deadline]);
        if (signature === publishedSignature) return;
        const props = { chores: snapshot.chores, pendingWidgetCompletionIds: [], remainingCount: Math.max(0, snapshot.remainingCount), updatedAt: snapshot.updatedAt, accessUntil: deadline };
        NextChoreWidget.updateTimeline([{ date: new Date(), props }, { date: new Date(deadline), props: { ...props, chores: [], remainingCount: 0, subscriptionLocked: true } }]);
        publishedSignature = signature;
      }).catch(() => undefined); return;
    }
    const signature = JSON.stringify([snapshot.chores, snapshot.remainingCount]);
    if (signature === publishedSignature) return;
    NextChoreWidget.updateSnapshot({
      chores: snapshot.chores,
      pendingWidgetCompletionIds: [],
      remainingCount: Math.max(0, snapshot.remainingCount),
      updatedAt: snapshot.updatedAt,
    });
    publishedSignature = signature;
  },

  async getPendingWidgetCompletionIds(): Promise<readonly string[]> {
    if (Platform.OS !== 'ios') return [];
    const entries = await traceStartup('widget.timeline', () => NextChoreWidget.getTimeline());
    const latest = entries.reduce<(typeof entries)[number] | null>((current, entry) => !current || entry.date > current.date ? entry : current, null);
    const currentEntries = subscriptionRequired ? entries.filter(entry => entry.props.updatedAt === latest?.props.updatedAt) : latest ? [latest] : [];
    const pendingIds = [...new Set(currentEntries.flatMap(entry => entry.props.pendingWidgetCompletionIds ?? []))];
    // The extension can change native props without changing the planner content.
    // Its pending actions still need the next snapshot to acknowledge them.
    if (pendingIds.length > 0) publishedSignature = undefined;
    return pendingIds;
  },
};

/** Expiry hides normal widget content while preserving actions already made before expiry. */
export async function lockSubscriptionWidget() {
  revision++; publishedSignature = undefined;
  const entries = await NextChoreWidget.getTimeline();
  const latest = entries.reduce<(typeof entries)[number] | null>((current, entry) => !current || entry.date > current.date ? entry : current, null);
  const pendingWidgetCompletionIds = [...new Set(entries.filter(entry => entry.props.updatedAt === latest?.props.updatedAt).flatMap(entry => entry.props.pendingWidgetCompletionIds ?? []))];
  NextChoreWidget.updateSnapshot({ chores: [], remainingCount: 0, pendingWidgetCompletionIds, updatedAt: new Date().toISOString(), accessUntil: 0, subscriptionLocked: true });
}
