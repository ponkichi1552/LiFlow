import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { EMPTY_LOCAL_CALENDAR, readLocalCalendar, readLocalCalendarDrafts, subscribeLocalCalendar } from '../../platform/storage/calendar-events';
import type { CalendarEditorDraft, LocalCalendarSnapshot } from '../../platform/storage/calendar-events';
import type { CalendarCategory } from '../../domain/calendar/events';
import type { LocalDate } from '../../domain/shared/types';
import { retainCalendarInputs } from './observed-snapshot';
import { usePersonalGoogleSync } from './use-personal-google-sync';
import { usePlannerData } from '@/hooks/use-planner-data';

const LocalCalendarContext = createContext<LocalCalendarBinding | null>(null);
/** Loads local events once at app startup and keeps every page on the same subscription. */
export function LocalCalendarProvider({ children }: { children: ReactNode }) {
  const database = useSQLiteContext(); const value = useObservedLocalCalendar(database, true);
  const { waitForInitialRead } = usePlannerData({ personal: true });
  const requestRange = usePersonalGoogleSync(database, waitForInitialRead);
  const binding = useMemo(() => ({ ...value, requestRange }), [value, requestRange]);
  return <LocalCalendarContext.Provider value={binding}>{children}</LocalCalendarContext.Provider>;
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
  const observed = useRef<{ database: SQLiteDatabase; snapshot: LocalCalendarSnapshot } | null>(null);
  const pending = useRef<{ database: SQLiteDatabase; promise: Promise<void>; again: boolean; full: boolean } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useCallback(async (draftsOnly = false) => {
    if (!database) return;
    const full = !draftsOnly || observed.current?.database !== database;
    if (pending.current?.database === database) { pending.current.again = true; pending.current.full ||= full; return pending.current.promise; }
    if (full) setLoading(true);
    const attempt = { database, promise: Promise.resolve(), again: false, full }; pending.current = attempt;
    const work = (async () => {
      let value = observed.current?.database === database ? observed.current.snapshot : EMPTY_LOCAL_CALENDAR;
      do { attempt.again = false; const full = attempt.full; attempt.full = false;
        value = full ? await readLocalCalendar(database) : { ...value, ...await readLocalCalendarDrafts(database) };
        if (alive.current && current.current === database && !attempt.again) { const drafts = (value.drafts ?? []).filter(draft => includeGroupDrafts || draft.audience !== 'group');
          const next = { ...value, drafts, draft: drafts[0] ?? null };
          observed.current = { database, snapshot: next };
          setSnapshot(previous => retainCalendarInputs(previous, next)); setError(null); }
      } while (attempt.again && alive.current && current.current === database);
    })().catch(cause => { if (alive.current && current.current === database) setError(cause instanceof Error ? cause.message : '予定を読み込めません。'); })
      .finally(() => { if (alive.current && current.current === database) setLoading(false); if (pending.current === attempt) pending.current = null; });
    attempt.promise = work; return work;
  }, [database, includeGroupDrafts]);
  const refresh = useCallback(() => reload(false), [reload]);
  useEffect(() => {
    if (!database) return;
    void refresh(); const unsubscribe = subscribeLocalCalendar(database, change => { if (change !== 'syncStatus') void reload(change === 'drafts'); });
    const appState = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { unsubscribe(); appState.remove(); };
  }, [database, refresh, reload]);
  return { database, snapshot, error, loading, refresh, canEditEvent: id => snapshot.events.find(row => row.id === id)?.readOnly !== true };
}
export interface LocalCalendarBinding {
  database?: SQLiteDatabase; snapshot: LocalCalendarSnapshot; loading: boolean; error: string | null; refresh: () => Promise<void>;
  shared?: { groupId: string; name: string; enabled: boolean };
  prepareDraft?: (draft: CalendarEditorDraft) => CalendarEditorDraft;
  canEditEvent?: (eventId: string) => boolean;
  requestRange?: (from: LocalDate, through: LocalDate) => void;
  categoriesFor?: (audience: 'personal' | 'group') => readonly CalendarCategory[];
  saveEvent?: (draft: CalendarEditorDraft, resetExceptions: boolean) => Promise<void>;
  deleteEvent?: (draft: CalendarEditorDraft) => Promise<void>;
  persistDraft?: (draft: CalendarEditorDraft) => Promise<void>;
  saveCategory?: (value: { id?: string; expectedRevision: number; name: string; color: string }, audience?: 'personal' | 'group') => Promise<string>;
}
