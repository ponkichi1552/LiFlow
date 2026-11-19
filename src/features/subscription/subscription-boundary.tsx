import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PropsWithChildren } from 'react';
import { ActivityIndicator, AppState, Text, View, useColorScheme } from 'react-native';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { typography } from '../../components/planner-ui';
import { finishStartupDisplay } from '../../platform/diagnostics/startup-splash';
import { startSubscriptions, subscribeSubscription, subscriptionRequired, subscriptionSnapshot, refreshSubscription } from '../../platform/subscription/runtime';
import { SubscriptionScreen } from './subscription-screen';

/** Internal QA builds retain their data flows; store-distribution config requires verified billing. */
export function SubscriptionBoundary({ children }: PropsWithChildren) {
  return subscriptionRequired ? <RequiredSubscription>{children}</RequiredSubscription> : children;
}
function RequiredSubscription({ children }: PropsWithChildren) {
  const state = useSyncExternalStore(subscribeSubscription, subscriptionSnapshot, subscriptionSnapshot);
  useEffect(() => { void startSubscriptions(); const listener = AppState.addEventListener('change', next => { if (next === 'active') void refreshSubscription(); }); return () => listener.remove(); }, []);
  useEffect(() => {
    if (state.phase === 'checking' || state.phase === 'active') return;
    let live = true; let attempt = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      void import('../../platform/subscription/stop-expired-features').then(module => live ? module.stopExpiredSubscriptionFeatures() : undefined)
        .catch(() => { if (live && attempt < 4) timer = setTimeout(stop, [1000, 5000, 30_000, 60_000][attempt++]); });
    };
    stop();
    const listener = AppState.addEventListener('change', next => { if (next === 'active') { attempt = 0; stop(); } });
    return () => { live = false; clearTimeout(timer); listener.remove(); };
  }, [state.phase, state.userId, state.entitlement]);
  useEffect(() => {
    if (!state.userId) return;
    let live = true; const userId = state.userId;
    const recover = () => { void import('../../platform/subscription/purchases').then(module => live ? module.recoverSubscriptionPurchases(userId) : undefined).catch(() => undefined); };
    // The normal content gets its first frame before native store recovery starts.
    const timer = setTimeout(recover, 1000);
    const listener = AppState.addEventListener('change', next => { if (next === 'active') recover(); });
    return () => { live = false; clearTimeout(timer); listener.remove(); };
  }, [state.userId]);
  if (state.phase === 'checking') return <SubscriptionChecking />;
  if (state.phase !== 'active') return <SubscriptionScreen />;
  return children;
}

function SubscriptionChecking() {
  const colors = plannerColorsForScheme(useColorScheme());
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 500);
    return () => clearTimeout(timer);
  }, []);
  return <View onLayout={finishStartupDisplay} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: colors.background }}>
    {visible ? <><ActivityIndicator color={colors.accent} /><Text accessibilityLiveRegion="polite" style={{ ...typography.body, color: colors.ink }}>契約を確認中…</Text></> : null}
  </View>;
}
