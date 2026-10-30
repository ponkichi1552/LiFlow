import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { SQLiteDatabase } from 'expo-sqlite';
import { EMPTY_LOCAL_CALENDAR, readLocalCalendar, subscribeLocalCalendar } from '../../platform/storage/calendar-events';
import type { LocalCalendarSnapshot } from '../../platform/storage/calendar-events';

/** This hook only observes personal SQLite. It never requests account or cloud access. */
export function useLocalCalendar(database?: SQLiteDatabase) {
  const [snapshot, setSnapshot] = useState<LocalCalendarSnapshot>(EMPTY_LOCAL_CALENDAR);
  const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const alive = useRef(true); const current = useRef(database);
  useLayoutEffect(() => { current.current = database; return () => { current.current = undefined; }; }, [database]);
  const pending = useRef<{ database: SQLiteDatabase; promise: Promise<void>; again: boolean } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (!database) return;
    if (pending.current?.database === database) { pending.current.again = true; return pending.current.promise; }
    setLoading(true);
    const attempt = { database, promise: Promise.resolve(), again: false }; pending.current = attempt;
    const work = (async () => {
      do { attempt.again = false; const value = await readLocalCalendar(database);
        if (alive.current && current.current === database) { setSnapshot(value); setError(null); }
      } while (attempt.again && alive.current && current.current === database);
    })().catch(cause => { if (alive.current && current.current === database) setError(cause instanceof Error ? cause.message : '予定を読み込めません。'); })
      .finally(() => { if (alive.current && current.current === database) setLoading(false); if (pending.current === attempt) pending.current = null; });
    attempt.promise = work; return work;
  }, [database]);
  useFocusEffect(useCallback(() => { void refresh(); return database ? subscribeLocalCalendar(database, () => { void refresh(); }) : undefined; }, [database, refresh]));
  return { database, snapshot, error, loading, refresh };
}
export type LocalCalendarBinding = ReturnType<typeof useLocalCalendar>;
