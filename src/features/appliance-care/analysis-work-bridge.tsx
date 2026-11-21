import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { usePlannerData } from '../../hooks/use-planner-data';
import { useWorkspace } from '../../hooks/use-workspace';
import { createDemandWorker } from '../google-sync/demand-worker';
import { waitForInitialFrame } from '../planner/initial-display-gate';

export function AnalysisWorkBridge() {
  const database = useSQLiteContext();
  const { waitForInitialRead } = usePlannerData({ personal: true });
  const { userId } = useWorkspace();
  useEffect(() => {
    if (!process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim()) return;
    const controller = new AbortController();
    let stop = () => {};
    void (async () => {
      await waitForInitialRead();
      await waitForInitialFrame();
      if (controller.signal.aborted) return;
      const [{ deviceAnalysisWork, subscribeAnalysisWork }, { setAnalysisBackgroundTask }, { resumeAnalysisWork }, { applianceCareApiBaseUrl }] = await Promise.all([
        import('../../platform/storage/analysis-work'), import('./analysis-background-task'),
        import('../../platform/appliance-care/analysis-work'), import('./api-client'),
      ]);
      const live = () => !controller.signal.aborted;
      if (!live()) return;
      let needsTask: boolean | undefined;
      const synchronizeTask = async () => {
        const pending = Boolean(userId && await deviceAnalysisWork(database).next(userId, applianceCareApiBaseUrl()));
        if (!live() || pending === needsTask) return;
        needsTask = pending;
        await setAnalysisBackgroundTask(pending).catch(() => { needsTask = undefined; });
      };
      const worker = createDemandWorker({
        active: () => live() && AppState.currentState === 'active',
        run: async () => userId ? resumeAnalysisWork(database, userId, { signal: controller.signal }) : false,
      });
      const wake = () => {
        worker.request();
        void synchronizeTask().catch(() => undefined);
      };
      const unsubscribe = subscribeAnalysisWork(wake);
      const lifecycle = AppState.addEventListener('change', state => { if (state === 'active') wake(); });
      stop = () => { unsubscribe(); lifecycle.remove(); worker.stop(); };
      wake();
    })().catch(() => undefined);
    return () => { controller.abort(); stop(); };
  }, [database, userId, waitForInitialRead]);
  return null;
}
