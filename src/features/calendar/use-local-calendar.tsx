import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { EMPTY_LOCAL_CALENDAR, readLocalCalendar, readLocalCalendarDrafts, readLocalCalendarHistoryPage, subscribeLocalCalendar } from '../../platform/storage/calendar-events';
import type { CalendarDraftAccess, CalendarDraftCleanup, CalendarEditorDraft, LocalCalendarSnapshot } from '../../platform/storage/calendar-events';
import type { CalendarCategory, CalendarEvent, CalendarException } from '../../domain/calendar/events';
import type { LocalDate } from '../../domain/shared/types';
import { retainCalendarInputs } from './observed-snapshot';
import { usePersonalGoogleSync } from './use-personal-google-sync';
import { usePlannerData } from '@/hooks/use-planner-data';
import { canEditPrivateCalendarEvent } from './private-event-projection';
import { isOwnBirthdayOn } from '../../domain/calendar/own-birthday';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { calendarReminderScope } from './reminder-preferences';
import { canReadCalendarDraft, useCalendarDraftAccess } from './use-calendar-draft-access';
import { recoverCalendarReminderUndos } from '../../platform/storage/calendar-reminders';
import { CalendarHistoryLimitError } from '../../platform/storage/calendar-event-rows';
import { addDays, localDateFromDate } from '../../domain/scheduling/local-date';
import { calendarMonth } from './events';

// A personal-only calendar must not initialize the native sharing runtime.
function groupDraftAuth() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const services = require('@/platform/sharing/firebase-services') as typeof import('@/platform/sharing/firebase-services');
  return services.isSharingConfigured() ? services.getSharingServices().auth : undefined;
}
const noSubscription = () => {};
const LocalCalendarContext = createContext<LocalCalendarBinding | null>(null);
/** Home uses the existing startup cache; no extra database read or sync is needed. */
export function useOwnBirthday(date: LocalDate) {
  const snapshot = useContext(LocalCalendarContext)?.snapshot;
  const events = snapshot?.events; const exceptions = snapshot?.exceptions;
  return useMemo(() => events ? isOwnBirthdayOn(date, events, exceptions) : false, [date, events, exceptions]);
}
/** Loads local events once at app startup and keeps every page on the same subscription. */
export function LocalCalendarProvider({ children }: { children: ReactNode }) {
  const database = useSQLiteContext(); const value = useObservedLocalCalendar(database);
  const { waitForInitialRead } = usePlannerData({ personal: true });
  const requestRange = usePersonalGoogleSync(database, waitForInitialRead);
  const binding = useMemo(() => ({ ...value, requestRange }), [value, requestRange]);
  return <LocalCalendarContext.Provider value={binding}>{children}</LocalCalendarContext.Provider>;
}
export function useLocalCalendar(database?: SQLiteDatabase, includeGroupDrafts = false): LocalCalendarBinding {
  const provided = useContext(LocalCalendarContext);
  const shared = provided?.database === database ? provided : null;
  const fallback = useObservedLocalCalendar(shared ? undefined : database);
  const binding = shared ?? fallback;
  const snapshot = binding.snapshot;
  const visible = useMemo(() => {
    if (includeGroupDrafts) return snapshot;
    const drafts = (snapshot.drafts ?? (snapshot.draft ? [snapshot.draft] : [])).filter(draft => draft.audience !== 'group');
    return { ...snapshot, drafts, draft: drafts[0] ?? null };
  }, [snapshot, includeGroupDrafts]);
  return { ...binding, snapshot: visible };
}

/** Read personal events and only the current viewer's unpublished group drafts from this SQLite file. */
function useObservedLocalCalendar(database?: SQLiteDatabase): LocalCalendarBinding {
  const workspace = useContext(WorkspaceContext);
  // An encrypted startup view can show its calendar before authentication. Drafts
  // still need live membership and should not bring Auth onto the initial render.
  const selected = workspace?.active?.protocol === 2 ? workspace.active : undefined;
  const membership = workspace?.group;
  const selectedGroup = database && workspace?.ready && selected && membership && selected.userId === workspace.userId
    && membership.userId === selected.userId && membership.groupId === selected.groupId && (membership.status === 'active' || membership.status === 'creating') ? selected : undefined;
  const hasGroup = Boolean(selectedGroup);
  const auth = useMemo(() => hasGroup ? groupDraftAuth() : undefined, [hasGroup]);
  const readAccount = useCallback(() => auth?.currentUser?.uid ?? null, [auth]);
  const subscribe = useCallback((changed: () => void) => auth?.onAuthStateChanged(changed) ?? noSubscription, [auth]);
  const account = useSyncExternalStore(subscribe, readAccount, readAccount);
  const groupId = account && selectedGroup?.userId === account ? selectedGroup.groupId : undefined;
  const ownerScope = useMemo(() => groupId ? calendarReminderScope(account, groupId) : undefined, [account, groupId]);
  const assertScope = useCalendarDraftAccess(groupId, ownerScope);
  const assertDraftAccess = useCallback((draft: CalendarEditorDraft) => {
    assertScope(draft);
    if (draft.audience === 'group' && readAccount() !== account) throw new Error('下書きを保存したアカウントを確認してください。');
  }, [assertScope, account, readAccount]);
  const source = useMemo(() => ({ database, ownerScope }), [database, ownerScope]);
  const [observedState, setObservedState] = useState<{ database: SQLiteDatabase; snapshot: LocalCalendarSnapshot; historyLimited: boolean; generation: number } | null>(null);
  const [initialDisplayRange] = useState(() => {
    const today = localDateFromDate(new Date());
    return { from: calendarMonth(today, -1), through: addDays(calendarMonth(today, 2), -1) };
  });
  const requestedRange = useRef(initialDisplayRange);
  const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const alive = useRef(true); const current = useRef<typeof source | null>(source);
  useLayoutEffect(() => { current.current = source; return () => { current.current = null; }; }, [source]);
  const workspaceSession = workspace?.active?.protocol === 2 && workspace.active.userId === account && workspace.active.groupId === groupId ? workspace.active.session : undefined;
  const appliedUndo = workspaceSession?.controller.actions.appliedCalendarReminderUndo;
  useEffect(() => {
    if (!database || !ownerScope || !appliedUndo) return;
    let mounted = true, pending = false;
    const isCurrent = () => mounted && current.current === source && readAccount() === account;
    const recover = () => {
      if (pending || !isCurrent()) return;
      pending = true;
      void recoverCalendarReminderUndos(database, ownerScope, appliedUndo, () => {
        if (!isCurrent()) throw new Error('通知を復元するアカウントが変わりました。');
      }).catch(() => { if (isCurrent()) setError('取り消した予定の通知を復元できませんでした。'); })
        .finally(() => { pending = false; });
    };
    recover();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') recover(); });
    return () => { mounted = false; subscription.remove(); };
  }, [database, ownerScope, source, readAccount, account, appliedUndo]);
  const observed = useRef<{ database: SQLiteDatabase; snapshot: LocalCalendarSnapshot; historyLimited: boolean; generation: number } | null>(null);
  const generation = useRef(0);
  const pending = useRef<{ source: typeof source; promise: Promise<void>; again: boolean; full: boolean } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useCallback(async (draftsOnly = false) => {
    if (!database || current.current !== source) return;
    const full = !draftsOnly || observed.current?.database !== database;
    if (pending.current?.source === source) { pending.current.again = true; pending.current.full ||= full; return pending.current.promise; }
    if (full) setLoading(true);
    const attempt = { source, promise: Promise.resolve(), again: false, full }; pending.current = attempt;
    const readOwner = () => current.current === source && account === readAccount() ? source.ownerScope : null;
    const work = (async () => {
      let value = observed.current?.database === database ? observed.current.snapshot : EMPTY_LOCAL_CALENDAR;
      let historyLimited = Boolean(observed.current?.database === database && observed.current.historyLimited);
      let failures = 0;
      do { attempt.again = false; const full = attempt.full; attempt.full = false;
        let boundedRange: typeof requestedRange.current | undefined;
        try {
          if (full) {
            if (!historyLimited) {
              try { value = await readLocalCalendar(database, readOwner); }
              catch (cause) {
                if (!(cause instanceof CalendarHistoryLimitError)) throw cause;
                historyLimited = true;
              }
            }
            if (historyLimited) {
              boundedRange = requestedRange.current;
              value = await readLocalCalendar(database, readOwner, boundedRange);
            }
          } else { value = { ...value, ...await readLocalCalendarDrafts(database, readOwner) }; }
          failures = 0;
        }
        catch (cause) {
          // Only an already queued newer request can retry a failed read. Keep
          // full reads stronger than draft refreshes, and bound persistent errors.
          attempt.full ||= full;
          if (boundedRange && boundedRange !== requestedRange.current) { attempt.again = true; continue; }
          if (alive.current && current.current === source) setError(cause instanceof Error ? cause.message : '予定を読み込めません。');
          if (++failures >= 2 || !attempt.again) break;
          continue;
        }
        // The first bounded read can finish after the viewport changes, before
        // loadRange has seen historyLimited and can queue a replacement itself.
        if (boundedRange && boundedRange !== requestedRange.current) {
          attempt.again = true;
          attempt.full = true;
        }
        if (alive.current && current.current === source && !attempt.again) {
          // The retained input arrays must also be the next draft read's baseline.
          // Otherwise every keystroke serializes the unchanged full event list again.
          const retained = retainCalendarInputs(observed.current?.database === database ? observed.current.snapshot : EMPTY_LOCAL_CALENDAR, value);
          const nextGeneration = ++generation.current;
          observed.current = { database, snapshot: retained, historyLimited, generation: nextGeneration };
          setObservedState({ database, snapshot: retained, historyLimited, generation: nextGeneration }); setError(null); }
      } while (attempt.again && alive.current && current.current === source);
    })().catch(cause => { if (alive.current && current.current === source) setError(cause instanceof Error ? cause.message : '予定を読み込めません。'); })
      .finally(() => { if (alive.current && current.current === source) setLoading(false); if (pending.current === attempt) pending.current = null; });
    attempt.promise = work; return work;
  }, [database, source, account, readAccount]);
  const refresh = useCallback(() => reload(false), [reload]);
  const loadRange = useCallback((from: LocalDate, through: LocalDate) => {
    const previous = requestedRange.current;
    if (previous.from === from && previous.through === through) return;
    const next = { from, through }; requestedRange.current = next;
    const currentObservation = observed.current;
    if (currentObservation && currentObservation.database === database && currentObservation.historyLimited) {
      // A normal snapshot does no extra read during passive calendar scrolling.
      // Large histories must replace the bounded visible projection after each
      // requested range changes, including when a previous read is still active.
      void reload(false);
    }
  }, [database, reload]);
  const readHistoryPage = useCallback(async (afterId?: string, expectedGeneration?: number) => {
    const currentObservation = observed.current;
    if (!database || current.current !== source || account !== readAccount() || currentObservation?.database !== database || !currentObservation.historyLimited)
      throw new Error('保存された予定を検索できません。カレンダーを読み直してください。');
    const readingGeneration = currentObservation.generation;
    if (expectedGeneration !== undefined && expectedGeneration !== readingGeneration) throw new Error('検索中にカレンダーの保存先が変わりました。');
    const value = await readLocalCalendarHistoryPage(database, afterId, 500);
    if (current.current !== source || account !== readAccount() || observed.current?.generation !== readingGeneration)
      throw new Error('検索中にカレンダーの保存先が変わりました。');
    return value;
  }, [database, source, account, readAccount]);
  useEffect(() => {
    if (!database) return;
    // Account changes only affect drafts unless a previous observer had a read in flight.
    void reload(!pending.current || pending.current.source === source);
    const unsubscribe = subscribeLocalCalendar(database, change => { if (change !== 'syncStatus') void reload(change === 'drafts'); });
    const appState = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { unsubscribe(); appState.remove(); };
  }, [database, source, refresh, reload]);
  const currentSnapshot = observedState && observedState.database === database ? observedState.snapshot : EMPTY_LOCAL_CALENDAR;
  const historyLimited = Boolean(observedState && observedState.database === database && observedState.historyLimited);
  const historyGeneration = observedState && observedState.database === database ? observedState.generation : 0;
  const visible = useMemo(() => {
    const drafts = (currentSnapshot.drafts ?? (currentSnapshot.draft ? [currentSnapshot.draft] : [])).filter(draft => canReadCalendarDraft(draft, groupId, ownerScope));
    return { ...currentSnapshot, drafts, draft: drafts[0] ?? null };
  }, [currentSnapshot, groupId, ownerScope]);
  return { database, snapshot: visible, draftOwnerScope: ownerScope ?? null, assertDraftAccess, error, loading: loading || Boolean(database && observedState?.database !== database), refresh,
    historyLimited, historyGeneration, loadRange, readHistoryPage,
    canEditEvent: (id, anchorDate) => canEditPrivateCalendarEvent(currentSnapshot, id, anchorDate) };
}
export interface LocalCalendarBinding {
  database?: SQLiteDatabase; snapshot: LocalCalendarSnapshot; loading: boolean; error: string | null; refresh: () => Promise<void>;
  shared?: { groupId: string; name: string; enabled: boolean; notificationScope?: string };
  prepareDraft?: (draft: CalendarEditorDraft) => CalendarEditorDraft;
  draftOwnerScope?: string | null;
  assertDraftAccess?: CalendarDraftAccess;
  canEditEvent?: (eventId: string, anchorDate?: LocalDate | null) => boolean;
  requestRange?: (from: LocalDate, through: LocalDate, options?: { refresh?: boolean }) => void;
  /** True only when a large saved history is currently exposed as a bounded read range. */
  historyLimited?: boolean;
  /** Increments when the saved calendar snapshot or connected Google account is re-read. */
  historyGeneration?: number;
  /** Refreshes the visible date range after the full history cap is exceeded. */
  loadRange?: (from: LocalDate, through: LocalDate) => void;
  /** Reads current-account history pages only for an explicit query in the bounded-history fallback. */
  readHistoryPage?: (afterId?: string, expectedGeneration?: number) => Promise<{ events: CalendarEvent[]; exceptions: CalendarException[]; nextAfterId?: string }>;
  categoriesFor?: (audience: 'personal' | 'group') => readonly CalendarCategory[];
  saveEvent?: (draft: CalendarEditorDraft, resetExceptions: boolean, draftCleanup?: CalendarDraftCleanup) => Promise<void | import('../../platform/storage/calendar-events').CalendarFutureSave>;
  restoreOccurrence?: (draft: CalendarEditorDraft) => Promise<void>;
  deleteEvent?: (draft: CalendarEditorDraft) => Promise<void>;
  persistDraft?: (draft: CalendarEditorDraft) => Promise<CalendarEditorDraft | void>;
  saveCategory?: (value: { id?: string; expectedRevision: number; name: string; color: string }, audience?: 'personal' | 'group') => Promise<string>;
}
