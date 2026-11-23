import { useIsFocused } from 'expo-router';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { deviceAnalysisWork, subscribeAnalysisWork } from '../../platform/storage/analysis-work';

type WorkStore = ReturnType<typeof deviceAnalysisWork>;

function useAnalysisQuery<T>(database: SQLiteDatabase | undefined, owner: string | null, key: string,
  read: (store: WorkStore, uid: string) => Promise<T>) {
  const focused = useIsFocused();
  const [snapshot, setSnapshot] = useState<{ database: SQLiteDatabase; owner: string; key: string; value?: T; failed?: boolean }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!database || !owner || !focused) return;
    let revision = 0;
    const load = () => {
      const current = ++revision;
      void read(deviceAnalysisWork(database), owner).then(value => {
        if (current === revision) setSnapshot({ database, owner, key, value });
      }).catch(() => {
        if (current !== revision) return;
        setSnapshot(before => ({
          database, owner, key, failed: true,
          value: before?.database === database && before.owner === owner && before.key === key ? before.value : undefined,
        }));
      });
    };
    const unsubscribe = subscribeAnalysisWork(load);
    const lifecycle = AppState.addEventListener('change', state => { if (state === 'active') load(); });
    load();
    return () => { revision++; lifecycle.remove(); unsubscribe(); };
  }, [database, owner, key, focused, read, attempt]);
  const current = snapshot && snapshot.database === database && snapshot.owner === owner && snapshot.key === key ? snapshot : undefined;
  return { focused, value: current?.value, failed: current?.failed, retry: () => setAttempt(before => before + 1) };
}

export function useTargetAnalysisWork(database?: SQLiteDatabase, owner: string | null = null, groupId?: string, applianceId?: string, workId?: string) {
  const read = useCallback((store: WorkStore, uid: string) => store.read(uid, { groupId, applianceId }, workId), [groupId, applianceId, workId]);
  return useAnalysisQuery(database, owner, JSON.stringify([groupId, applianceId, workId]), read);
}

export function useAnalysisWorkList(database: SQLiteDatabase | undefined, owner: string | null, groupId?: string) {
  const read = useCallback((store: WorkStore, uid: string) => store.list(uid, groupId), [groupId]);
  const { value, failed, retry } = useAnalysisQuery(database, owner, groupId ?? '', read);
  return { items: value ?? [], failed, retry };
}
