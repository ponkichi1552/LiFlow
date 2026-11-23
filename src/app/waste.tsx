import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';

import { SettingsHeader } from '@/features/settings/settings-navigation';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePlannerData } from '@/hooks/use-planner-data';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { deleteWeeklyWasteSchedule, readWasteScheduleSettings, restoreDeletedWasteSchedule, saveWeeklyWasteSchedule, setWasteOccurrenceHidden } from '@/platform/storage/repository';
import { sharedRepositoryAdapter } from '@/platform/storage/shared-repository-adapter';
import { sharedLocalDate } from '@/features/sharing/group-clock';
import { WasteSettingsContent } from '@/features/waste/waste-settings-content';

export default function WasteScreen() {
  const { snapshot: planner, error: plannerError, refresh: refreshPlanner, database } = usePlannerData();
  const userId = useContext(WorkspaceContext)?.userId;
  const readSequence = useRef(0);
  const [localRead, setLocalRead] = useState<{ database: typeof database; value?: Awaited<ReturnType<typeof readWasteScheduleSettings>>; failed?: boolean }>();
  const referenceDate = planner?.today;
  const readLocal = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    const request = ++readSequence.current;
    const isCurrent = () => !signal?.aborted && readSequence.current === request;
    try {
      let date = referenceDate;
      if (!date && userId) {
        // Only the owner's local clock matters here. Their shared plan and
        // calendar availability should never hold up the collection list.
        const preferences = await import('@/platform/sharing/private-calendar-secrets')
          .then(({ nativePrivatePlannerPreferences }) => nativePrivatePlannerPreferences(userId).read()).catch(() => null);
        if (preferences?.ownerUserId === userId) date = sharedLocalDate(new Date(), preferences.timeZone);
      }
      if (!isCurrent()) return;
      const value = await readWasteScheduleSettings(database, date);
      if (isCurrent()) setLocalRead({ database, value });
      return true;
    } catch {
      if (isCurrent()) setLocalRead(current => ({ database, value: current?.database === database ? current.value : undefined, failed: true }));
      return false;
    }
  }, [database, referenceDate, userId]);
  const localDatabase = !sharedRepositoryAdapter(database);
  const needsLocalRead = localDatabase && (!planner || Boolean(plannerError));
  useEffect(() => {
    if (!needsLocalRead) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => readLocal(controller.signal));
    return () => controller.abort();
  }, [needsLocalRead, readLocal]);
  const local = localRead?.database === database ? localRead : undefined;
  const snapshot = (needsLocalRead ? local?.value : undefined) ?? planner;
  const refresh = async () => {
    if (!needsLocalRead) { await refreshPlanner(); return; }
    if (await readLocal() === false) throw new Error('端末の収集日データを開けませんでした。');
    void refreshPlanner().catch(() => {});
  };
  const header = <SettingsHeader title="ゴミ収集日" onBack={() => router.back()} />;
  if (!snapshot) return <PlannerLoadState header={header} message="曜日設定を読み込んでいます。"
    error={localDatabase ? local?.failed ? '端末の収集日データを開けませんでした。' : null : plannerError}
    retry={localDatabase ? async () => { await readLocal(); } : refreshPlanner} />;

  return <WasteSettingsContent snapshot={snapshot} header={header} refresh={refresh}
    saveSchedule={(schedule, editing) => saveWeeklyWasteSchedule(database, schedule, editing)}
    deleteSchedule={async id => {
      const receipt = await deleteWeeklyWasteSchedule(database, id);
      return receipt ? { label: receipt.label, action: () => restoreDeletedWasteSchedule(database, receipt.token) } : null;
    }}
    setHidden={(id, date, hidden) => setWasteOccurrenceHidden(database, id, date, hidden)} />;
}
