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

/** One app-wide observer reconciles only calendar keys; housework settings and queues remain independent. */
export function CalendarNotificationBridge() {
  const { database } = usePlannerData({ personal: true }); const local = useLocalCalendar(database);
  const reminders = useCalendarReminders(database); const workspace = useWorkspace(); const display = useWorkspaceDisplay();
  const peek = useCallback(() => display.peek(), [display]);
  const prepared = useSyncExternalStore(display.subscribe, peek, peek);
  const active = workspace.active?.protocol === 2 ? workspace.active : null;
  const [tick, setTick] = useState(0);
  useEffect(() => { const resume = AppState.addEventListener('change', state => { if (state === 'active') setTick(n => n + 1); });
    const timer = setInterval(() => { if (AppState.currentState === 'active') setTick(n => n + 1); }, 30 * 60_000);
    return () => { resume.remove(); clearInterval(timer); };
  }, []);
  const sources = useMemo(() => {
    const result = [{ scope: 'personal', events: local.snapshot.events, exceptions: local.snapshot.exceptions }];
    if (active && workspace.userId === active.userId && prepared?.model.viewerUserId === active.userId && prepared.model.plan.groupId === active.groupId) {
      const shared = projectSharedCalendarRecords(prepared.model.calendar ?? [], active.groupId);
      result.push({ scope: calendarReminderScope(active.userId, active.groupId), events: shared.events, exceptions: shared.exceptions });
    }
    return result;
  }, [local.snapshot.events, local.snapshot.exceptions, active, workspace.userId, prepared]);
  const identity = useMemo(() => ({ database, active, userId: workspace.userId, sources, settings: reminders.settings, ready: workspace.ready }), [database, active, workspace.userId, sources, reminders.settings, workspace.ready]);
  const latest = useRef<typeof identity | null>(identity); useLayoutEffect(() => { latest.current = identity; return () => { latest.current = null; }; }, [identity]);
  useEffect(() => {
    if (!workspace.ready || reminders.loading || reminders.error || reminders.settings.enabled && (local.loading || local.error)) return;
    let live = true;
    const current = () => { if (!live || latest.current !== identity) throw new Error('通知を更新するアカウント・予定が変わりました。'); };
    void (async () => {
      let verified = sources;
      if (active && reminders.settings.enabled) try { await active.record(); } catch { verified = sources.filter(source => source.scope === 'personal'); }
      current();
      await reconcileLocalNotifications(expoLocalNotificationGateway, { prefix: CALENDAR_NOTIFICATION_PREFIX, enabled: reminders.settings.enabled,
        desired: calendarNotificationRequests(reminders.settings, verified), assertCurrent: current });
    })().catch(() => { /* Resume/input changes retry a failed native update; saved rules stay intact. */ });
    return () => { live = false; };
  }, [active, identity, local.loading, local.error, reminders.loading, reminders.error, reminders.settings, sources, tick, workspace.ready]);
  const handled = useRef(new Set<string>());
  const timeZone = active && prepared?.model.plan.groupId === active.groupId ? prepared.model.plan.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    if (!workspace.ready || local.loading) return;
    const receive: Parameters<typeof addNotificationResponseReceivedListener>[0] = response => {
      const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
      if (handled.current.has(key)) return;
      const destination = calendarNotificationDestination(response.notification.request.content.data, sources, timeZone);
      if (!destination) return;
      handled.current.add(key);
      router.navigate({ pathname: '/(tabs)/explore', params: { calendarDate: destination.date, calendarMinute: destination.minute === null ? '' : String(destination.minute), calendarJump: key } });
      const last = getLastNotificationResponse();
      if (last?.notification.request.identifier === response.notification.request.identifier && last.actionIdentifier === response.actionIdentifier) clearLastNotificationResponse();
    };
    const stop = addNotificationResponseReceivedListener(receive);
    const last = getLastNotificationResponse(); if (last) receive(last);
    return () => stop.remove();
  }, [sources, timeZone, workspace.ready, local.loading]);
  return null;
}
