import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { usePlannerData } from '../../hooks/use-planner-data';
import { waitForInitialFrame } from '../planner/initial-display-gate';
import { deviceAnalysisDeliveries } from '../../platform/storage/analysis-deliveries';
import { recoverNativeAnalysisReceipts } from '../../platform/appliance-care/receipt-recovery';
import { observeSharingUser } from '../../platform/sharing/auth';
import { isSharingConfigured } from '../../platform/sharing/firebase-services';
import { createAnalysisReceiptRecovery } from './receipt-recovery';

export function AnalysisReceiptBridge() {
  const database = useSQLiteContext(); const { waitForInitialRead } = usePlannerData({ personal: true });
  useEffect(() => {
    let stopped = false; const store = deviceAnalysisDeliveries(database);
    const recovery = createAnalysisReceiptRecovery({
      hasPending: async () => { await waitForInitialRead(); await waitForInitialFrame(); return !stopped && store.hasPending(); },
      flush: () => recoverNativeAnalysisReceipts(store), subscribe: listener => store.subscribe(listener),
      watchAccount: listener => isSharingConfigured() && process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim()
        ? observeSharingUser(() => listener()) : () => {},
    });
    if (AppState.currentState === 'active') recovery.resume();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') recovery.resume(); else recovery.pause(); });
    return () => { stopped = true; subscription.remove(); recovery.stop(); };
  }, [database, waitForInitialRead]);
  return null;
}
