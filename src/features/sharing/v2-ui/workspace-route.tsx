import { useCallback, useLayoutEffect, useRef } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AppButton, Card, Page, typography } from '../../../components/planner-ui';
import { Text } from 'react-native';
import { useWorkspace } from '../../../hooks/use-workspace';
import { usePlannerData } from '../../../hooks/use-planner-data';
import { V2GroupScreen } from './group-screen';
import type { V2GroupScreenProps } from './group-screen';
import { createV2ScreenSession } from './screen-session';
import { v2OwnerScheduleSettings } from './owner-preferences';
import { sharingFailureMessage, subscribeSharingChanges } from '@/platform/sharing/workspaces';
import { createV2PrivateTaskSource } from './private-overlay';
import { readPersonalPlannerOverlaySnapshot, setPersonalDateTaskCompleted, mirrorSharedChoreCompletions } from '../../../platform/storage/repository';
import { syncGoogleTasksAfterLocalCompletion } from '@/features/google-sync/coordinator';
import { useLocalCalendar } from '../../calendar/use-local-calendar';
import type { SQLiteDatabase } from 'expo-sqlite';

function CalendarWorkspaceScreen({ database, ...props }: V2GroupScreenProps & { database: SQLiteDatabase }) {
  const localCalendar = useLocalCalendar(database);
  return <V2GroupScreen {...props} localCalendar={localCalendar} />;
}

/** Only an explicitly selected, authenticated v2 workspace reaches these controls. */
export function V2WorkspaceRoute({ view }: { view: V2GroupScreenProps['view'] }) {
  const context = useWorkspace(); const { database: personalDatabase, snapshot: personalSnapshot, refresh: refreshPersonal } = usePlannerData(); const router = useRouter();
  const params = useLocalSearchParams<{ choreId?: string; occurrenceId?: string; subjectId?: string; anchorDate?: string; applianceId?: string }>();
  const active = context.active?.protocol === 2 ? context.active : null;
  const current = useRef<{ active: typeof active; userId: string | null; database: typeof personalDatabase } | null>({ active, userId: context.userId, database: personalDatabase });
  useLayoutEffect(() => {
    current.current = { active, userId: context.userId, database: personalDatabase };
    return () => { current.current = null; };
  }, [active, context.userId, personalDatabase]);
  const assertWorkspaceAccess = useCallback(async () => {
    const matches = () => active && current.current?.active === active && current.current.userId === active.userId && current.current.database === personalDatabase;
    if (!matches()) throw new Error('個人家事を操作するアカウント・グループが変わりました。');
    await active!.record();
    if (!matches()) throw new Error('個人家事を操作するアカウント・グループが変わりました。');
  }, [active, personalDatabase]);
  const openCalendar = useCallback(async () => {
    await assertWorkspaceAccess();
    const { openPrivateCalendarRuntime } = await import('../../../platform/sharing/private-calendar-runtime');
    await assertWorkspaceAccess(); const calendar = openPrivateCalendarRuntime(active!.userId); await assertWorkspaceAccess(); return calendar;
  }, [active, assertWorkspaceAccess]);
  const subscribe = useCallback((changed: () => void) => {
    let stopped = false; let stopCalendar: (() => void) | undefined;
    const matches = () => !stopped && active && current.current?.active === active && current.current.userId === active.userId;
    const stopSharing = subscribeSharingChanges((scope) => {
      if (matches() && scope?.userId === active!.userId && scope.groupId === active!.groupId) changed();
    });
    void openCalendar().then(calendar => { if (matches()) stopCalendar = calendar.subscribe(() => { if (matches()) changed(); }); }).catch(() => {});
    return () => { stopped = true; stopSharing(); stopCalendar?.(); };
  }, [active, openCalendar]);
  const loadSession = useCallback(async () => {
    if (!active || context.userId !== active.userId) throw new Error('共有グループを選択してください。');
    await active.record();
    const assertPersonalAccess = assertWorkspaceAccess;
    const privateTasks = createV2PrivateTaskSource({ ownerUserId: active.userId, assertAccess: assertPersonalAccess,
      mirrorShared: (source, guard) => mirrorSharedChoreCompletions(personalDatabase, source, guard),
      readSnapshot: async (instant) => ({ ...await readPersonalPlannerOverlaySnapshot(personalDatabase, instant), ownerUserId: active.userId }),
      save: (command, guard) => setPersonalDateTaskCompleted(personalDatabase, command, guard),
      afterChange: async () => {
        await assertPersonalAccess(); syncGoogleTasksAfterLocalCompletion(personalDatabase);
        try { await refreshPersonal({ force: true }); }
        catch { throw new Error('個人家事は保存済みです。表示を更新するため再読込してください。'); }
      } });
    return createV2ScreenSession({ groupId: active.groupId, userId: active.userId, now: () => new Date(),
      privateTasks,
      calendar: {
        readForPlan: async () => { const calendar = await openCalendar(); const value = await calendar.readForPlan(); await assertWorkspaceAccess(); return value; },
        readOwnCalendar: async target => { const calendar = await openCalendar(); const value = await calendar.readOwnCalendar(target); await assertWorkspaceAccess(); return value; },
      },
      controller: { ...active.session.controller, sync: () => active.sync({ force: true }) },
      readPreferences: async () => {
        await active.record();
        const calendar = await openCalendar(); const own = await calendar.readPlannerPreferences?.(); await assertWorkspaceAccess();
        return v2OwnerScheduleSettings(active.userId, personalSnapshot?.settings, own);
      } });
  }, [active, context.userId, personalDatabase, refreshPersonal, personalSnapshot, assertWorkspaceAccess, openCalendar]);
  if (!context.ready || !active || active.userId !== context.userId) return <Page><Card><Text style={typography.body}>共有グループを選択してください。</Text>
    <AppButton title="共有グループへ" onPress={() => router.replace('/sharing')} /></Card></Page>;
  const text = (value: unknown) => typeof value === 'string' ? value : undefined;
  const focus = text(params.anchorDate); const anchorContext = focus ? { anchorDate: focus } : {};
  const record = context.groups.find((record) => record.groupId === active.groupId);
  const Screen = view === 'calendar' ? CalendarWorkspaceScreen : V2GroupScreen;
  return <Screen key={`${active.userId}:${active.groupId}:${active.identity.deviceId}`} database={personalDatabase} purpose="workspace" view={view} loadSession={loadSession} subscribe={subscribe}
    onCalendarNavigate={tab => router.replace(({ home: '/group-v2', calendar: '/group-v2/calendar', chores: '/group-v2/chores', appliances: '/group-v2/appliances' } as const)[tab])}
    workspaceName={record?.displayName} workspaceError={record?.lastErrorCode ? sharingFailureMessage({ code: record.lastErrorCode }) : undefined}
    anchorDate={focus} choreId={text(params.choreId)} occurrenceId={text(params.occurrenceId)} subjectId={text(params.subjectId)} applianceId={text(params.applianceId)}
    onManage={() => router.push({ pathname: '/sharing', params: { groupId: active.groupId } })}
    onBack={() => view !== 'home' && router.canGoBack() ? router.back() : router.replace('/sharing')}
    onRound={(occurrenceId, subjectId, anchorDate) => router.push({ pathname: '/group-v2/round', params: { occurrenceId, subjectId, ...(anchorDate ? { anchorDate } : anchorContext) } })}
    onDate={(occurrenceId, subjectId) => router.push({ pathname: '/group-v2/date', params: { occurrenceId, subjectId, ...anchorContext } })}
    onAssignment={(occurrenceId, subjectId) => router.push({ pathname: '/group-v2/assignment', params: { occurrenceId, subjectId, ...anchorContext } })}
    onConfiguration={(choreId) => router.push({ pathname: '/group-v2/configuration', params: { choreId } })}
    onDetails={(choreId) => router.push({ pathname: '/group-v2/details', params: { choreId } })}
    onChoreCreated={(choreId) => router.replace({ pathname: '/group-v2/details', params: { choreId } })}
    onManageChores={() => router.push('/group-v2/chores')} onAddChore={() => router.push('/group-v2/add-chore')}
    onGroupPolicy={() => router.push('/group-v2/group-rules')}
    onNotifications={() => router.push('/group-v2/notifications')}
    onGoogleTasks={() => router.push('/group-v2/google-tasks')}
    onPersonalCopy={() => router.push('/group-v2/personal-copy')}
    onWaste={() => router.push('/group-v2/waste')}
    onAppliances={() => router.push('/group-v2/appliances')}
    onAppliance={(applianceId) => router.push({ pathname: '/group-v2/appliance', params: { applianceId } })}
    onApplianceReview={(applianceId) => router.push({ pathname: '/group-v2/appliance-review', params: applianceId ? { applianceId } : {} })}
    onDateRights={(choreId) => router.push({ pathname: '/group-v2/date-rights', params: { choreId } })}
    onCalendar={() => router.push('/group-v2/calendar')} onHistory={() => router.push('/group-v2/history')}
    onRequests={() => router.push('/group-v2/requests')} onAssignmentRequests={() => router.push('/group-v2/assignment-requests')} />;
}
