import { useEffect } from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { AppButton, Card, Page, typography } from '../../../components/planner-ui';
import { Text } from 'react-native';
import { useWorkspace } from '../../../hooks/use-workspace';
import { usePlannerData } from '../../../hooks/use-planner-data';
import { V2GroupScreen } from './group-screen';
import { readOptionsForView, type V2GroupScreenProps } from './group-screen';
import { useWorkspaceDisplay } from './workspace-data';
import { sharingFailureMessage } from '@/platform/sharing/workspaces';
import { useLocalCalendar } from '../../calendar/use-local-calendar';
import type { SQLiteDatabase } from 'expo-sqlite';

function CalendarWorkspaceScreen({ database, ...props }: V2GroupScreenProps & { database: SQLiteDatabase }) {
  const localCalendar = useLocalCalendar(database, true);
  return <V2GroupScreen {...props} localCalendar={localCalendar} />;
}

/** Only an explicitly selected, authenticated v2 workspace reaches these controls. */
export function V2WorkspaceRoute({ view }: { view: V2GroupScreenProps['view'] }) {
  const context = useWorkspace(); const { database: personalDatabase, snapshot: personalSnapshot, refresh: refreshPersonal, readError: readPersonalError } = usePlannerData({ personal: true }); const router = useRouter();
  const params = useLocalSearchParams<{ choreId?: string; occurrenceId?: string; subjectId?: string; anchorDate?: string; applianceId?: string; source?: string; productName?: string; returnTo?: string }>();
  const navigation = useNavigation() as { addListener(event: 'tabPress', callback: () => void): () => void };
  useEffect(() => {
    if (view !== 'chores' && view !== 'guide') return;
    return navigation.addListener('tabPress', () => router.setParams({ choreId: undefined, source: undefined, returnTo: undefined }));
  }, [navigation, router, view]);
  const active = context.active?.protocol === 2 ? context.active : null;
  const { loadSession, subscribe, peek, sharedCompletion, personalCompletion, invalidate } = useWorkspaceDisplay();
  const selected = active ?? context.startupDisplay?.record;
  if (!context.ready || !selected || selected.userId !== context.userId) return <Page><Card><Text style={typography.body}>所属グループを確認してください。</Text>
    <AppButton title="共有グループへ" onPress={() => router.replace('/sharing')} /></Card></Page>;
  const text = (value: unknown) => typeof value === 'string' ? value : undefined;
  const focus = text(params.anchorDate); const anchorContext = focus ? { anchorDate: focus } : {};
  const record = context.group;
  const Screen = view === 'calendar' ? CalendarWorkspaceScreen : V2GroupScreen;
  return <Screen key={`${selected.userId}:${selected.groupId}:${context.group?.localGeneration ?? 'initial'}`} database={personalDatabase} purpose="workspace" view={view} loadSession={loadSession} subscribe={subscribe} sharedCompletion={sharedCompletion} personalCompletion={personalCompletion} invalidateCompletionDisplay={invalidate} lifecycleManaged initialDisplay={peek(readOptionsForView(view, focus, text(params.choreId), text(params.applianceId)))}
    onCalendarNavigate={tab => router.navigate(({ home: '/(tabs)', calendar: '/(tabs)/explore', chores: '/(tabs)/guide', appliances: '/(tabs)/manual' } as const)[tab])}
    workspaceName={record?.displayName} workspaceError={context.error ?? (record?.lastErrorCode ? sharingFailureMessage({ code: record.lastErrorCode }) : undefined)}
    anchorDate={focus} choreId={text(params.choreId)} occurrenceId={text(params.occurrenceId)} subjectId={text(params.subjectId)} applianceId={text(params.applianceId)} initialProductName={text(params.productName)}
    personalGuide={personalSnapshot ? { snapshot: personalSnapshot, database: personalDatabase, refresh: refreshPersonal, readError: readPersonalError } : undefined} guideSource={text(params.source) === 'personal' ? 'personal' : 'shared'}
    onGuide={(choreId, source) => router.navigate({ pathname: '/(tabs)/guide', params: { choreId, source, returnTo: view === 'home' ? 'home' : view === 'calendar' ? 'calendar' : undefined } })}
    onManage={() => router.push({ pathname: '/sharing/group/[groupId]', params: { groupId: selected.groupId } })}
    onBack={() => {
      if (view === 'guide') {
        router.setParams({ choreId: undefined, source: undefined, returnTo: undefined });
        if (params.returnTo === 'home') router.navigate('/(tabs)');
        else if (params.returnTo === 'calendar') router.navigate('/(tabs)/explore');
      } else if (view !== 'home' && router.canGoBack()) router.back();
      else router.replace('/sharing');
    }}
    onRound={(occurrenceId, subjectId, anchorDate) => router.push({ pathname: '/group-v2/round', params: { occurrenceId, subjectId, ...(anchorDate ? { anchorDate } : anchorContext) } })}
    onDate={(occurrenceId, subjectId) => router.push({ pathname: '/group-v2/date', params: { occurrenceId, subjectId, ...anchorContext } })}
    onAssignment={(occurrenceId, subjectId) => router.push({ pathname: '/group-v2/assignment', params: { occurrenceId, subjectId, ...anchorContext } })}
    onConfiguration={(choreId) => router.push({ pathname: '/group-v2/configuration', params: { choreId } })}
    onDetails={(choreId) => router.push({ pathname: '/group-v2/details', params: { choreId } })}
    onChoreCreated={(choreId) => router.replace({ pathname: '/group-v2/details', params: { choreId } })}
    onManageChores={() => router.navigate('/(tabs)/guide')} onAddChore={() => router.push('/group-v2/add-chore')}
    onGroupPolicy={() => router.push('/group-v2/group-rules')}
    onNotifications={() => router.push('/group-v2/notifications')}
    onGoogleTasks={() => router.push('/group-v2/google-tasks')}
    onPersonalCopy={() => router.push('/group-v2/personal-copy')}
    onWaste={() => router.push('/group-v2/waste')}
    onAppliances={() => router.navigate('/(tabs)/manual')}
    onAppliance={(applianceId) => router.push({ pathname: '/group-v2/appliance', params: { applianceId } })}
    onApplianceReview={(applianceId, productName) => router.push({ pathname: '/group-v2/appliance-review', params: applianceId ? { applianceId } : productName ? { productName } : {} })}
    onPersonalAppliance={id => router.push({ pathname: '/manual/appliances/[id]', params: { id, returnTo: '/manual' } })}
    onDateRights={(choreId) => router.push({ pathname: '/group-v2/date-rights', params: { choreId } })}
    onCalendar={() => router.navigate('/(tabs)/explore')} onHistory={() => router.push('/group-v2/history')}
    onRequests={() => router.push('/group-v2/requests')} onAssignmentRequests={() => router.push('/group-v2/assignment-requests')} />;
}
