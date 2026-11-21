import { useIsFocused } from 'expo-router';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { deviceAnalysisWork, subscribeAnalysisWork } from '../../platform/storage/analysis-work';

type WorkStore = ReturnType<typeof deviceAnalysisWork>;

function useAnalysisQuery<T>(database: SQLiteDatabase | undefined, owner: string | null, key: string,
  read: (store: WorkStore, uid: string) => Promise<T>) {
  const focused = useIsFocused();
  const [snapshot, setSnapshot] = useState<{ database: SQLiteDatabase; owner: string; key: string; value: T }>();
  useEffect(() => {
    if (!database || !owner || !focused) return;
    let revision = 0;
    const load = () => {
      const current = ++revision;
      void read(deviceAnalysisWork(database), owner).then(value => {
        if (current === revision) setSnapshot({ database, owner, key, value });
      }).catch(() => undefined);
    };
    const unsubscribe = subscribeAnalysisWork(load);
    const lifecycle = AppState.addEventListener('change', state => { if (state === 'active') load(); });
    load();
    return () => { revision++; lifecycle.remove(); unsubscribe(); };
  }, [database, owner, key, focused, read]);
  const value = snapshot && snapshot.database === database && snapshot.owner === owner && snapshot.key === key ? snapshot.value : undefined;
  return { focused, value };
}

export function useTargetAnalysisWork(database?: SQLiteDatabase, owner: string | null = null, groupId?: string, applianceId?: string) {
  const read = useCallback((store: WorkStore, uid: string) => store.read(uid, { groupId, applianceId }), [groupId, applianceId]);
  return useAnalysisQuery(database, owner, JSON.stringify([groupId, applianceId]), read);
}

export function useAnalysisWorkList(database: SQLiteDatabase | undefined, owner: string | null, groupId?: string) {
  const read = useCallback((store: WorkStore, uid: string) => store.list(uid, groupId), [groupId]);
  return useAnalysisQuery(database, owner, groupId ?? '', read).value ?? [];
}
