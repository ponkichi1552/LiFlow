import { useCallback, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Share } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { SettingsGroup } from '../../components/settings-controls';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { PersonalGoogleCalendarSettings } from '../calendar/personal-google-settings';
import { AccountSharedGoogleCalendar, AccountSharedGoogleTasks } from './account-shared-google';
import { PrivatePreferenceScreen } from '../sharing/private-planner/preference-screen';
import { PrivateCalendarDeviceScreen } from '../sharing/private-calendar/device-screen';
import { PrivateCalendarSourceScreen } from '../sharing/private-calendar/source-screen';
import type { PrivateCalendarDeviceSession } from '../sharing/private-calendar/device-session';
import type { PrivateCalendarPairingReference, PrivateCalendarPairingRequest } from '../sharing/private-calendar/pairing';
import type { HouseholdPlannerSettings as PlannerSettings } from '../../domain/chores/types';
import type { Weekday } from '../../domain/shared/types';
import { SettingsList } from './settings-navigation';

export function AccountConnections({ database, settings, personalTasks, calendarOptions, onTasksOpen }: {
  database: SQLiteDatabase; settings: Pick<PlannerSettings, 'restDays' | 'heavyDailyLimit' | 'normalDailyLimit'>;
  personalTasks: ReactNode; calendarOptions: ReactNode; onTasksOpen(): void;
}) {
  const workspace = useContext(WorkspaceContext); const shared = workspace?.active?.protocol === 2 && workspace.active.userId === workspace.userId;
  const scope = `${workspace?.userId ?? 'local'}:${shared ? workspace?.active?.groupId : ''}`;
  // Hydrate saved Google controls after display without changing their connection settings.
  useEffect(() => { onTasksOpen(); }, [onTasksOpen]);
  return <SettingsList key={scope}>
    <SettingsGroup title="Googleカレンダー">
      <PersonalGoogleCalendarSettings database={database} embedded />
      {!shared ? calendarOptions : null}
      {shared ? <AccountSharedGoogleCalendar /> : null}
      {workspace?.userId ? <AccountCalendarSource userId={workspace.userId} /> : null}
    </SettingsGroup>
    <SettingsGroup title="Google Tasks">
      {personalTasks}{shared ? <AccountSharedGoogleTasks /> : null}
    </SettingsGroup>
    {workspace?.userId ? <SettingsGroup title="端末間同期">
      <AccountDeviceSync key={workspace.userId} userId={workspace.userId} settings={settings} />
    </SettingsGroup> : null}
  </SettingsList>;
}

function AccountCalendarSource({ userId }: { userId: string }) {
  const workspace = useContext(WorkspaceContext), current = useRef(workspace?.userId);
  useLayoutEffect(() => { current.current = workspace?.userId; return () => { current.current = undefined; }; }, [workspace?.userId]);
  const load = useCallback(async () => {
    const guard = () => { if (current.current !== userId) throw new Error('設定を開くアカウントが変わりました。'); };
    guard(); const { openPrivateCalendarRuntime } = await import('../../platform/sharing/private-calendar-runtime'); guard();
    return openPrivateCalendarRuntime(userId);
  }, [userId]);
  return <PrivateCalendarSourceScreen embedded key={userId} loadRuntime={load} onBack={() => {}} onDevices={() => {}} />;
}

function AccountDeviceSync({ userId, settings }: {
  userId: string; settings: Pick<PlannerSettings, 'restDays' | 'heavyDailyLimit' | 'normalDailyLimit'>;
}) {
  const workspace = useContext(WorkspaceContext);
  const current = useRef({ userId: workspace?.userId, settings });
  useLayoutEffect(() => {
    current.current = { userId: workspace?.userId, settings };
    return () => { current.current.userId = undefined; };
  }, [workspace?.userId, settings]);
  const guard = useCallback(() => { if (current.current.userId !== userId) throw new Error('設定を開くアカウントが変わりました。'); }, [userId]);
  const loadDevices = useCallback(async (): Promise<PrivateCalendarDeviceSession> => {
    guard(); const { openPrivateCalendarDevices } = await import('../../platform/sharing/private-calendar-devices'); guard();
    const session = openPrivateCalendarDevices(userId);
    const checked = <A extends unknown[], R>(work: (...args: A) => Promise<R>) => async (...args: A) => {
      guard(); const value = await work(...args); guard(); return value;
    };
    return { ...session, read: checked(session.read), synchronizeDevices: checked(session.synchronizeDevices),
      initializeFirstDevice: checked(session.initializeFirstDevice), prepareConfirmedReference: checked(session.prepareConfirmedReference),
      approveConfirmedRequest: checked(session.approveConfirmedRequest), acceptApproval: checked(session.acceptApproval),
      issueConnectionCode: checked(session.issueConnectionCode), connectWithCode: checked(session.connectWithCode),
      observeConnections: () => { guard(); return session.observeConnections(); },
      changeMain: checked(session.changeMain), revokeDevice: checked(session.revokeDevice), dismissReviewed: checked(session.dismissReviewed) };
  }, [guard, userId]);
  const load = useCallback(async () => {
    guard();
    const [{ nativePrivatePlannerPreferences }, { openPrivateCalendarRuntime }, { getDeviceTimeZone }] = await Promise.all([
      import('../../platform/sharing/private-calendar-secrets'), import('../../platform/sharing/private-calendar-runtime'), import('../google-sync/calendar-availability'),
    ]); guard();
    const runtime = openPrivateCalendarRuntime(userId); const value = current.current.settings;
    return { store: nativePrivatePlannerPreferences(userId), defaults: { timeZone: getDeviceTimeZone(), restDays: value.restDays as Weekday[],
      loadLimits: { heavyDailyLimit: value.heavyDailyLimit, normalDailyLimit: value.normalDailyLimit }, allowedBands: [] },
      ...(runtime.plannerSync ? { sync: { engine: runtime.plannerSync, synchronize: runtime.syncPlannerPreferences } } : {}) };
  }, [guard, userId]);
  const share = useCallback(async (value: PrivateCalendarPairingReference | PrivateCalendarPairingRequest | string) => {
    guard(); await Share.share({ message: typeof value === 'string' ? value : JSON.stringify(value) }); guard();
  }, [guard]);
  return <PrivateCalendarDeviceScreen embedded loadSession={loadDevices} onBack={() => {}} onShare={share}
    synchronization={<PrivatePreferenceScreen syncOnly embedded load={load} onBack={() => {}} />} />;
}
