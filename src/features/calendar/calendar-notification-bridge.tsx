import { router } from 'expo-router';
import { addNotificationResponseReceivedListener, getLastNotificationResponse, clearLastNotificationResponse } from 'expo-notifications';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { usePlannerData } from '../../hooks/use-planner-data';
import { useWorkspace } from '../../hooks/use-workspace';
import { useLocalCalendar } from './use-local-calendar';
import { useCalendarReminders } from './use-calendar-reminders';
import { calendarReminderScope } from '../../platform/storage/calendar-reminders';
import { useWorkspaceDisplay } from '../sharing/v2-ui/workspace-data';
import { projectSharedCalendarRecords } from './shared-events';
import { calendarNotificationDestination, calendarNotificationRequests, CALENDAR_NOTIFICATION_PREFIX } from './calendar-notifications';
import { reconcileLocalNotifications } from '../notifications/reconcile-local-notifications';
import { expoLocalNotificationGateway } from '../../platform/notifications/expo-local-notification-gateway';
import { calendarReminderMinutes } from './reminder-preferences';
import type { LocalDate } from '../../domain/shared/types';
import { addDays, parseLocalDate } from '../../domain/scheduling/local-date';
import { readLocalCalendarEventSource, subscribeLocalCalendar } from '../../platform/storage/calendar-events';
import type { LocalCalendarSnapshot } from '../../platform/storage/calendar-events';
import type { SQLiteDatabase } from 'expo-sqlite';

function useReminderHistory(database: SQLiteDatabase | undefined, historyLimited: boolean, enabled: boolean, tick: number) {
  const source = useMemo(() => ({ database, historyLimited, enabled }), [database, historyLimited, enabled]);
  const [range, setRange] = useState<{ source: typeof source; value: Pick<LocalCalendarSnapshot, 'events' | 'exceptions'> }>();
  useEffect(() => {
    const { database, historyLimited, enabled } = source;
    if (!database || !historyLimited || !enabled) return;
    let live = true, pending = false, dirty = false;
    const reload = async () => {
      if (pending) { dirty = true; return; }
      pending = true;
      try {
        do {
          dirty = false;
          const today = new Date().toISOString().slice(0, 10) as LocalDate;
          try {
            const value = await readLocalCalendarEventSource(database, { from: addDays(today, -2), through: addDays(today, 64) });
            if (live && !dirty) setRange({ source, value });
          } catch { /* Preserve valid scheduled notices until a later read succeeds. */ }
        } while (live && dirty);
      } finally { pending = false; }
    };
    const unsubscribe = subscribeLocalCalendar(database, change => {
      if (change === 'events' || change === 'sync') { setRange(undefined); void reload(); }
    });
    void reload();
    return () => { live = false; unsubscribe(); };
  }, [source, tick]);
  return range?.source === source ? range.value : undefined;
}

/** One app-wide observer reconciles only calendar keys; housework settings and queues remain independent. */
export function CalendarNotificationBridge() {
  const { database } = usePlannerData({ personal: true }); const local = useLocalCalendar(database);
  const reminders = useCalendarReminders(database); const workspace = useWorkspace(); const display = useWorkspaceDisplay();
  const peek = useCallback(() => display.peek(), [display]);
  const prepared = useSyncExternalStore(display.subscribe, peek, peek);
  const active = workspace.active?.protocol === 2 ? workspace.active : null;
  const group = workspace.group;
  const groupScope = group?.status === 'active' && group.userId === workspace.userId ? calendarReminderScope(group.userId, group.groupId) : null;
  const sameActive = active && active.userId === workspace.userId && (!group || groupScope && group.groupId === active.groupId) ? active : null;
  const preparedModel = prepared?.model === workspace.startupDisplay?.model ? undefined : prepared?.model;
  const restoringScope = !sameActive && groupScope && (workspace.restoration === 'waiting'
    || workspace.startupDisplay?.record.userId === group?.userId && workspace.startupDisplay?.record.groupId === group?.groupId)
    ? groupScope : null;
  const [tick, setTick] = useState(0);
  useEffect(() => { const resume = AppState.addEventListener('change', state => { if (state === 'active') setTick(n => n + 1); });
    const timer = setInterval(() => { if (AppState.currentState === 'active') setTick(n => n + 1); }, 30 * 60_000);
    return () => { resume.remove(); clearInterval(timer); };
  }, []);
  const historyLimited = local.historyLimited === true;
  const hasPersonalReminders = reminders.settings.enabled && reminders.settings.rules.some(rule => rule.scope === 'personal' && rule.minutes !== null);
  const reminderHistory = useReminderHistory(database, historyLimited, hasPersonalReminders, tick);
  const personal = historyLimited ? reminderHistory : local.snapshot;
  const waitingForPersonal = historyLimited && hasPersonalReminders && !personal;
  const personalEvents = personal?.events, personalExceptions = personal?.exceptions;
  const sources = useMemo(() => {
    const result = personalEvents && personalExceptions ? [{ scope: 'personal', events: personalEvents, exceptions: personalExceptions }] : [];
    if (sameActive && preparedModel?.viewerUserId === sameActive.userId && preparedModel.plan.groupId === sameActive.groupId && preparedModel.calendar) {
      const shared = projectSharedCalendarRecords(preparedModel.calendar, sameActive.groupId);
      result.push({ scope: calendarReminderScope(sameActive.userId, sameActive.groupId), events: shared.events, exceptions: shared.exceptions });
    }
    return result;
  }, [personalEvents, personalExceptions, sameActive, preparedModel]);
  const identity = useMemo(() => ({ database, sameActive, restoringScope, userId: workspace.userId, sources, settings: reminders.settings, ready: workspace.ready }), [database, sameActive, restoringScope, workspace.userId, sources, reminders.settings, workspace.ready]);
  const latest = useRef<typeof identity | null>(identity); useLayoutEffect(() => { latest.current = identity; return () => { latest.current = null; }; }, [identity]);
  useEffect(() => {
    if (!workspace.ready || reminders.loading || reminders.error || reminders.settings.enabled && !historyLimited && (local.loading || local.error)) return;
    let live = true;
    const current = () => { if (!live || latest.current !== identity) throw new Error('通知を更新するアカウント・予定が変わりました。'); };
    void (async () => {
      let verified = sources, retainScope = restoringScope;
      if (sameActive && reminders.settings.enabled) {
        let approved = false;
        try {
          const record = await sameActive.record();
          approved = record.status === 'active' && record.groupId === sameActive.groupId && record.userId === sameActive.userId;
        } catch { /* Authorization could not be confirmed. */ }
        if (!approved) verified = sources.filter(source => source.scope === 'personal');
        else {
          const scope = calendarReminderScope(sameActive.userId, sameActive.groupId);
          if (!sources.some(source => source.scope === scope)) retainScope = scope;
        }
      }
      current();
      await reconcileLocalNotifications(expoLocalNotificationGateway, { prefix: CALENDAR_NOTIFICATION_PREFIX, enabled: reminders.settings.enabled,
        desired: calendarNotificationRequests(reminders.settings, verified), assertCurrent: current,
        retainExisting: retainScope || waitingForPersonal ? request => {
          const data = request.data;
          return data?.kind === 'calendar-event' && typeof data.scope === 'string' && (data.scope === retainScope || data.scope === 'personal' && waitingForPersonal)
            && typeof data.eventId === 'string' && typeof data.anchorDate === 'string'
            && calendarReminderMinutes(reminders.settings, data.scope, data.eventId, data.anchorDate as LocalDate) !== null;
        } : undefined,
      });
    })().catch(() => { /* Resume/input changes retry a failed native update; saved rules stay intact. */ });
    return () => { live = false; };
  }, [sameActive, restoringScope, identity, local.loading, local.error, reminders.loading, reminders.error, reminders.settings, sources, tick, workspace.ready, historyLimited, waitingForPersonal]);
  const handled = useRef(new Set<string>());
  const timeZone = sameActive && preparedModel?.plan.groupId === sameActive.groupId ? preparedModel.plan.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    if (!workspace.ready || local.loading && !historyLimited) return;
    let live = true;
    const resolving = new Set<string>();
    const receive: Parameters<typeof addNotificationResponseReceivedListener>[0] = response => {
      const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
      if (handled.current.has(key)) return;
      const data = response.notification.request.content.data;
      const open = (destination: ReturnType<typeof calendarNotificationDestination>) => {
        if (!live || !destination || handled.current.has(key)) return;
        handled.current.add(key);
        router.navigate({ pathname: '/(tabs)/explore', params: { calendarDate: destination.date, calendarMinute: destination.minute === null ? '' : String(destination.minute), calendarJump: key } });
        const last = getLastNotificationResponse();
        if (last?.notification.request.identifier === response.notification.request.identifier && last.actionIdentifier === response.actionIdentifier) clearLastNotificationResponse();
      };
      if (!database || !historyLimited || data?.kind !== 'calendar-event' || data.scope !== 'personal') {
        open(calendarNotificationDestination(data, sources, timeZone)); return;
      }
      if (typeof data.eventId !== 'string' || typeof data.anchorDate !== 'string') return;
      const anchorDate = data.anchorDate as LocalDate;
      try { parseLocalDate(anchorDate); } catch { return; }
      if (resolving.has(key)) return;
      resolving.add(key);
      void readLocalCalendarEventSource(database, undefined, { eventId: data.eventId, anchorDate })
        .then(value => open(calendarNotificationDestination(data, [{ scope: 'personal', events: value.events, exceptions: value.exceptions }], timeZone)))
        .catch(() => undefined).finally(() => resolving.delete(key));
    };
    const stop = addNotificationResponseReceivedListener(receive);
    const last = getLastNotificationResponse(); if (last) receive(last);
    return () => { live = false; stop.remove(); };
  }, [sources, timeZone, workspace.ready, local.loading, database, historyLimited]);
  return null;
}
