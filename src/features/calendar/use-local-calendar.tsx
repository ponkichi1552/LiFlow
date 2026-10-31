import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { SQLiteDatabase } from 'expo-sqlite';
import { EMPTY_LOCAL_CALENDAR, readLocalCalendar, subscribeLocalCalendar } from '../../platform/storage/calendar-events';
import type { CalendarEditorDraft, LocalCalendarSnapshot } from '../../platform/storage/calendar-events';

/** This hook only observes personal SQLite. It never requests account or cloud access. */
export function useLocalCalendar(database?: SQLiteDatabase, includeGroupDrafts = false): LocalCalendarBinding {
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
        if (alive.current && current.current === database) { const drafts = (value.drafts ?? []).filter(draft => includeGroupDrafts || draft.audience !== 'group'); setSnapshot({ ...value, drafts, draft: drafts[0] ?? null }); setError(null); }
      } while (attempt.again && alive.current && current.current === database);
    })().catch(cause => { if (alive.current && current.current === database) setError(cause instanceof Error ? cause.message : '予定を読み込めません。'); })
      .finally(() => { if (alive.current && current.current === database) setLoading(false); if (pending.current === attempt) pending.current = null; });
    attempt.promise = work; return work;
  }, [database, includeGroupDrafts]);
  useFocusEffect(useCallback(() => { void refresh(); return database ? subscribeLocalCalendar(database, () => { void refresh(); }) : undefined; }, [database, refresh]));
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
