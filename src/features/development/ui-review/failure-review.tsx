import { useEffect, useState, useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { PlannerLoadState } from '../../../components/planner-load-state';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { typography } from '../../../components/planner-typography';
import { SettingsCheckbox } from '../../../components/settings-checkbox';
import { SettingsAction, SettingsGroup, SettingsStatus } from '../../../components/settings-controls';
import { WorkspaceContext } from '../../../contexts/workspace-context';
import { INITIAL_CATEGORIES, newEventDraft, type CalendarEvent } from '../../../domain/calendar/events';
import { formatJapaneseDate } from '../../../domain/scheduling/local-date';
import { CalendarSearchContent } from '../../calendar/calendar-search';
import { calendarSearchDestination, type CalendarSearchDestination } from '../../calendar/search';
import type { LocalCalendarBinding } from '../../calendar/use-local-calendar';
import type { V2GoogleControl } from '../../../platform/storage/sharing-v2-google-tasks';
import { NotificationPermissionRecovery } from '../../notifications/notification-permission-recovery';
import { V2GoogleTasksScreen, type V2GoogleTaskUiRuntime } from '../../sharing/v2-ui/google-tasks-screen';
import { HomeReview } from './home-review';
import { createPlannerRefreshController } from '../../planner/refresh-controller';
import { isTransientPlannerRead } from '../../../platform/storage/planner-read-retry';

export const failureReviewScenarios = [
  { id: 'home-read', label: 'ホームの読み込みから自動で復旧', screenTitle: 'ホーム' },
  { id: 'home-loading', label: 'ホームの読み込み中', screenTitle: 'ホーム' },
  { id: 'search-history', label: '予定検索の追加読み込みに失敗', screenTitle: '予定の検索' },
  { id: 'search-partial', label: '予定検索で一部だけ取得', screenTitle: '予定の検索' },
  { id: 'search-empty', label: '予定検索の一致が0件', screenTitle: '予定の検索' },
  { id: 'notification-denied', label: '端末で通知を拒否', screenTitle: '通知設定' },
  { id: 'notification-off', label: '通知は許可済み・アプリ側はオフ', screenTitle: '通知設定' },
  { id: 'notification-on', label: 'カレンダー通知がオン', screenTitle: '通知設定' },
  { id: 'sync-read', label: 'Google連携の読み込み失敗', screenTitle: 'Google連携' },
  { id: 'sync-auth', label: 'Googleの再認証が必要', screenTitle: 'Google連携' },
  { id: 'sync-unlinked', label: 'Google Tasksを未接続', screenTitle: 'Google連携' },
  { id: 'sync-paused', label: 'Google Tasksを一時停止', screenTitle: 'Google連携' },
] as const;

type Scenario = typeof failureReviewScenarios[number]['id'];
type SearchScenario = Extract<Scenario, `search-${string}`>;
type SyncScenario = Extract<Scenario, `sync-${string}`>;

export function FailureReview({ scenario, onExit }: { scenario: string; onExit?(): void }) {
  switch (scenario) {
    case 'home-read':
    case 'home-loading':
      return <WorkspaceContext.Provider value={null}><HomeLoadReview key={scenario} loading={scenario === 'home-loading'} /></WorkspaceContext.Provider>;
    case 'search-history':
    case 'search-partial':
    case 'search-empty':
      return <SearchReview key={scenario} scenario={scenario} onExit={onExit} />;
    case 'notification-denied':
      return <PermissionReview />;
    case 'notification-off':
      return <PermissionReview key={scenario} initiallyAllowed initiallyEnabled={false} />;
    case 'notification-on':
      return <PermissionReview key={scenario} initiallyAllowed />;
    case 'sync-read':
    case 'sync-auth':
    case 'sync-unlinked':
    case 'sync-paused':
      return <SyncReview key={scenario} scenario={scenario} />;
    default:
      return null;
  }
}

function HomeLoadReview({ loading }: { loading: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [reader] = useState(() => {
    let attempts = 0;
    return createPlannerRefreshController({
      load: async () => {
        if (++attempts < 3) throw new Error('SQLITE_BUSY: database is locked');
        return { snapshot: true, canPublishWidget: false };
      },
      retryInBackground: isTransientPlannerRead, weather: async () => null, publish() {},
    });
  });
  const read = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  useEffect(() => {
    if (loading) return;
    void reader.refresh();
    return () => reader.invalidate();
  }, [loading, reader]);
  if (loaded || read.snapshot) return <HomeReview scenario="mixed" />;
  return <View style={styles.page}>
    <PlannerLoadState title="今日の家事" message="今日の家事を読み込んでいます。" error={null} />
    {loading ? <View style={styles.footer}><SettingsAction placement="page" title="テストデータの読み込みを完了" onPress={() => setLoaded(true)} /></View> : null}
  </View>;
}

const timeZone = 'Asia/Tokyo';
const focusDate = '2026-11-20';
const storedEvents: CalendarEvent[] = [
  { ...newEventDraft('2026-09-09', timeZone), id: 'review-smoke-alarm', revision: 1, title: '火災報知器の点検' },
  { ...newEventDraft('2025-04-18', timeZone), id: 'review-water-heater', revision: 1, title: '給湯器の点検' },
];

function createSearchBinding(scenario: SearchScenario): LocalCalendarBinding {
  let failed = false;
  return {
    snapshot: { events: scenario === 'search-empty' ? storedEvents : [], categories: [...INITIAL_CATEGORIES], exceptions: [], draft: null },
    loading: false, error: null, refresh: async () => {},
    historyLimited: scenario !== 'search-empty',
    async readHistoryPage(cursor) {
      if (scenario === 'search-partial' && !cursor) return { events: [storedEvents[0]], exceptions: [], nextAfterId: storedEvents[0].id };
      if (!failed) {
        failed = true;
        throw new Error('保存済みの予定を読み込めませんでした。');
      }
      return { events: [storedEvents[1]], exceptions: [] };
    },
  };
}

function SearchReview({ scenario, onExit }: { scenario: SearchScenario; onExit?(): void }) {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<CalendarSearchDestination>();
  const [local, setLocal] = useState(() => createSearchBinding(scenario));
  if (open) return <CalendarSearchContent local={local} initialQuery={scenario === 'search-empty' ? '棚卸し' : '点検'}
    focusDate={focusDate} displayTimeZone={timeZone} shortenTitles
    resolveSelection={(draft, events, exceptions) => calendarSearchDestination(draft, events, exceptions, focusDate, timeZone)}
    onClose={onExit ?? (() => setOpen(false))} onSelect={destination => { setSelected(destination); setOpen(false); }} />;
  const match = storedEvents.find(event => event.startDate === selected?.date);
  return <View style={styles.content}>
    {match ? <SettingsGroup compact title={match.title}><SettingsStatus>{formatJapaneseDate(match.startDate, { year: true })}</SettingsStatus></SettingsGroup> : null}
    <SettingsAction placement="page" title="最初の状態で検索を開く" onPress={() => {
      setLocal(createSearchBinding(scenario)); setSelected(undefined); setOpen(true);
    }} />
  </View>;
}

function PermissionReview({ initiallyAllowed = false, initiallyEnabled = true }: { initiallyAllowed?: boolean; initiallyEnabled?: boolean }) {
  const colors = plannerColorsForScheme(useColorScheme());
  const [allowed, setAllowed] = useState(initiallyAllowed);
  const [enabled, setEnabled] = useState(initiallyEnabled);
  const [enablePending, setEnablePending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  function returnFromSettings(granted: boolean) {
    setAllowed(granted);
    if (granted && enablePending) { setEnabled(true); setEnablePending(false); }
    setSettingsOpen(false);
  }
  return <ScrollView contentContainerStyle={styles.content}>
    {settingsOpen ? <SettingsGroup compact title="端末の通知設定（テスト用）">
      <SettingsAction title="許可して戻る" onPress={() => returnFromSettings(true)} />
      <SettingsAction title="許可せず戻る" onPress={() => returnFromSettings(false)} />
    </SettingsGroup> : <SettingsGroup compact title="カレンダー通知" action={<SettingsCheckbox accessibilityLabel="カレンダー通知を受け取る" value={enabled}
      onValueChange={value => {
        if (value && !allowed) { setEnablePending(true); return; }
        setEnablePending(false); setEnabled(value);
      }} />}>
      <SettingsStatus>通知するタイミングは予定ごとに選択。</SettingsStatus>
      {!allowed && (enabled || enablePending) ? <>
        <Text accessibilityRole="alert" style={[typography.caption, { color: colors.warning }]}>端末の通知がオフです。</Text>
        <NotificationPermissionRecovery checkPermission={async () => allowed} openSettings={async () => setSettingsOpen(true)} />
      </> : null}
      {allowed ? <SettingsStatus>端末で通知が許可されています。</SettingsStatus> : null}
    </SettingsGroup>}
  </ScrollView>;
}

function createSyncRuntime(scenario: SyncScenario): V2GoogleTaskUiRuntime {
  const subject = 'review-google-user';
  const label = '確認用アカウント';
  const lastSync = '2026-11-19T00:00:00Z';
  const now = '2026-11-20T00:00:00Z';
  let readFailure = scenario === 'sync-read';
  let needsAuth = scenario === 'sync-auth';
  let state: NonNullable<V2GoogleControl['state']> = { householdId: 'review-group', accountSubject: subject, enabled: !['sync-paused', 'sync-unlinked'].includes(scenario),
    status: needsAuth ? 'authRequired' : 'idle', retryCount: 0, lastSuccessfulSyncAt: lastSync, updatedAt: lastSync };
  let unlinked = scenario === 'sync-unlinked';
  let revision = 1;
  const control = (): V2GoogleControl => unlinked ? { state: null, label: null, revision } : { state, label, revision };
  return {
    async readControl() {
      if (readFailure) { readFailure = false; throw new Error('共有家事の接続状態を読み込めませんでした。'); }
      return control();
    },
    async reviewConnection() { return { subject, label, connectionRevision: revision }; },
    async connect() {
      needsAuth = false; unlinked = false; revision++;
      state = { ...state, enabled: true, disconnected: false, status: 'idle', updatedAt: now };
      return control();
    },
    async pause(_expectedRevision, disconnected = false) {
      revision++;
      state = { ...state, enabled: false, disconnected, updatedAt: now };
      return control();
    },
    async synchronize() {
      if (needsAuth) return { kind: 'authRequired', code: 'review-auth-required' };
      state = { ...state, status: 'idle', lastSuccessfulSyncAt: now, updatedAt: now };
      return { kind: 'success', updated: 1 };
    },
  };
}

function SyncReview({ scenario }: { scenario: SyncScenario }) {
  const [load] = useState(() => {
    const runtime = createSyncRuntime(scenario);
    return async () => runtime;
  });
  return <ScrollView contentContainerStyle={styles.content}>
    <V2GoogleTasksScreen embedded load={load} onBack={() => {}} />
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 16, paddingVertical: 12, gap: 12, width: '100%', maxWidth: 640, alignSelf: 'center' },
  footer: { paddingHorizontal: 16, paddingBottom: 12 },
});
