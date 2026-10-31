import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { EMPTY_LOCAL_CALENDAR, readLocalCalendar, subscribeLocalCalendar } from '../../platform/storage/calendar-events';
import type { CalendarEditorDraft, LocalCalendarSnapshot } from '../../platform/storage/calendar-events';
import { retainCalendarInputs } from './observed-snapshot';

const LocalCalendarContext = createContext<LocalCalendarBinding | null>(null);
/** Loads local events once at app startup and keeps every page on the same subscription. */
export function LocalCalendarProvider({ children }: { children: ReactNode }) {
  const database = useSQLiteContext(); const value = useObservedLocalCalendar(database, true);
  return <LocalCalendarContext.Provider value={value}>{children}</LocalCalendarContext.Provider>;
}
export function useLocalCalendar(database?: SQLiteDatabase, includeGroupDrafts = false): LocalCalendarBinding {
  const provided = useContext(LocalCalendarContext);
  const shared = provided?.database === database ? provided : null;
  const fallback = useObservedLocalCalendar(shared ? undefined : database, includeGroupDrafts);
  const snapshot = shared?.snapshot;
  const filtered = useMemo(() => {
    if (!snapshot || includeGroupDrafts) return snapshot;
    const drafts = (snapshot.drafts ?? []).filter(draft => draft.audience !== 'group');
    return { ...snapshot, drafts, draft: drafts[0] ?? null };
  }, [snapshot, includeGroupDrafts]);
  return shared ? { ...shared, snapshot: filtered! } : fallback;
}

/** SQLite observation never requests account or cloud access. */
function useObservedLocalCalendar(database?: SQLiteDatabase, includeGroupDrafts = false): LocalCalendarBinding {
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
        if (alive.current && current.current === database) { const drafts = (value.drafts ?? []).filter(draft => includeGroupDrafts || draft.audience !== 'group');
          setSnapshot(previous => retainCalendarInputs(previous, { ...value, drafts, draft: drafts[0] ?? null })); setError(null); }
      } while (attempt.again && alive.current && current.current === database);
    })().catch(cause => { if (alive.current && current.current === database) setError(cause instanceof Error ? cause.message : '予定を読み込めません。'); })
      .finally(() => { if (alive.current && current.current === database) setLoading(false); if (pending.current === attempt) pending.current = null; });
    attempt.promise = work; return work;
  }, [database, includeGroupDrafts]);
  useEffect(() => {
    if (!database) return;
    void refresh(); const unsubscribe = subscribeLocalCalendar(database, () => { void refresh(); });
    const appState = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { unsubscribe(); appState.remove(); };
  }, [database, refresh]);
  return { database, snapshot, error, loading, refresh };
}
export interface LocalCalendarBinding {
  database?: SQLiteDatabase; snapshot: LocalCalendarSnapshot; loading: boolean; error: string | null; refresh: () => Promise<void>;
  shared?: { groupId: string; name: string; enabled: boolean };
  prepareDraft?: (draft: CalendarEditorDraft) => CalendarEditorDraft;
  canEditEvent?: (eventId: string) => boolean;
  saveEvent?: (draft: CalendarEditorDraft, resetExceptions: boolean) => Promise<void>;
  deleteEvent?: (draft: CalendarEditorDraft) => Promise<void>;
  persistDraft?: (draft: CalendarEditorDraft) => Promise<void>;
  saveCategory?: (value: { id?: string; expectedRevision: number; name: string; color: string }, audience?: 'personal' | 'group') => Promise<string>;
}
