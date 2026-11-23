import { CalendarNotificationSettings } from '@/features/calendar/calendar-notification-settings';
import { NotificationPermissionRecovery, useDeviceNotificationPermission } from '@/features/notifications/notification-permission-recovery';
import { useSettingsAutosave } from '@/features/settings/use-settings-autosave';
import { BackgroundSyncDiagnostics } from '@/features/google-sync/background-diagnostics';
import { subscribeToGoogleAccountChanges } from '@/features/google-sync/account-change-events';
import { FormTextInput as TextInput } from '../components/form-text-input';
import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SettingsCheckbox } from '@/components/settings-checkbox';

import { AppButton, Card, Page, palette, typography } from '@/components/planner-ui';
import { GeneralGroupNotifications } from '@/features/settings/general-group-notifications';
import { BirthdaySettings } from '@/features/calendar/birthday-settings';
import { CalendarField } from '@/features/calendar/calendar-field';
import { PersonalGoogleCalendarSettings } from '@/features/calendar/personal-google-settings';
import { DataCredits, WeatherAttribution } from '@/components/data-credits';
import type { FrequencyMode } from '@/domain/chores/types';
import type { Weekday } from '@/domain/shared/types';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePersonalSettingsData } from '@/hooks/use-personal-settings-data';
import { usePlannerData } from '@/hooks/use-planner-data';
import { FirstRunSetupForm } from '@/features/onboarding/first-run-setup';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { municipalityWeatherLocation } from '@/features/weather/municipality-search';
import type { WeatherRegionCandidate } from '@/features/weather/municipality-search';
import { useMunicipalitySuggestions } from '@/features/weather/use-municipality-suggestions';
import {
  clearWeatherLocation,
  completeFirstSetup,
  loadGoogleSyncState,
  loadCalendarAvailabilityState,
  LOCAL_HOUSEHOLD_ID,
  saveWeatherLocation,
  setNotificationsEnabled,
  setHouseworkNotificationTime,
  loadPersonalPlacementPreferences,
  savePersonalPlacementPreferences,
  updatePlannerSettings,
} from '@/platform/storage/repository';
import type { PersonalSettingsView } from '@/platform/storage/personal-settings-view';
import { ExpoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';
import { getGoogleSyncOAuthConfig } from '@/features/google-sync/google-oauth-config';
import type { GoogleSyncState } from '@/features/google-sync/contracts';
import { configurePersonalGoogleTaskSync, syncGoogleTasks } from '@/features/google-sync/coordinator';
import { registerGoogleSyncBackgroundTask, unregisterGoogleSyncBackgroundTask } from '@/features/google-sync/background-task';
import { authorizeGoogleCalendarAvailability, authorizeGoogleTasks, hasGoogleTasksSession } from '@/platform/google-tasks/google-sign-in-gateway';
import type { CalendarAvailabilityState } from '@/features/google-sync/calendar-availability';
import { configureGoogleCalendarAvailability } from '@/features/google-sync/calendar-settings';
import { sharingSessionUser } from '@/platform/sharing/workspaces';
import { GoogleAccountMismatchError } from '@/features/google-sync/account-binding';
import { getDeviceTimeZone } from '@/features/google-sync/calendar-availability';
import { createOwnerRhythmSettings, type PlannerRhythm } from '@/features/settings/owner-rhythm-settings';
import { subscriptionRequired } from '@/platform/subscription/runtime';
import { PersonalCapacitySettings } from '@/features/settings/personal-capacity-settings';
import { SettingsAction, SettingsStatus, SettingsPanel, SettingsSegments } from '@/components/settings-controls';
import { plannerColorsForScheme } from '@/components/planner-theme';
import { localDateFromDate } from '@/domain/scheduling/local-date';
import type { PersonalPlacementPreferences } from '@/features/planner/personal-placement-preferences';
import { sharedLocalDate } from '@/features/sharing/group-clock';
import { AccountSignOut, GoogleAccountSwitch } from '@/features/settings/google-account-switch';
import { AccountConnections } from '@/features/settings/account-connections';
import { AccountPersonalGoogleTasks } from '@/features/settings/personal-google-tasks-settings';
import { AccountOperationContext } from '@/features/settings/account-operation';
import { AppearanceControls, SettingsHeader, SettingsList, SettingsNavigationScreen, SettingsRow, SettingsSection, returnFromSettings, settingsCategory, settingsTitles, type SettingsCategory } from '@/features/settings/settings-navigation';

const modeOptions: { id: FrequencyMode; label: string }[] = [
  { id: 'frequent', label: 'こまめ' },
  { id: 'balanced', label: '適度' },
  { id: 'relaxed', label: '少なめ' },
];
const weekdays: { id: Weekday; label: string }[] = [
  { id: 1, label: '月' }, { id: 2, label: '火' }, { id: 3, label: '水' }, { id: 4, label: '木' },
  { id: 5, label: '金' }, { id: 6, label: '土' }, { id: 7, label: '日' },
];
const notificationGateway = new ExpoLocalNotificationGateway();
const readNotificationPermission = () => notificationGateway.hasPermission();
const weatherSearchDrafts = new WeakMap<SQLiteDatabase, { base: string; query: string }>();

export default function SettingsScreen() {
  const params = useLocalSearchParams<{ section?: string }>();
  if (params.section === 'personal-setup') return <SharedHomePersonalSetup />;
  const section = settingsCategory(params.section);
  if (!section || section === 'chores' || section === 'appearance' || section === 'credits') return <SettingsNavigationScreen section={section} />;
  return <SettingsDataScreen key={section} section={section} />;
}

function SharedHomePersonalSetup() {
  const workspace = useContext(WorkspaceContext);
  const selected = workspace?.active?.protocol === 2 ? workspace.active : workspace?.startupDisplay?.record;
  if (!workspace?.ready || !selected || selected.userId !== workspace.userId) return <Redirect href="/(tabs)" />;
  return <PersonalSetup key={`${selected.userId}:${selected.groupId}`} />;
}

function PersonalSetup() {
  const personal = usePlannerData({ personal: true });
  const [startedSaving, setStartedSaving] = useState(false);
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const back = () => returnFromSettings();
  const { snapshot, error, database, refresh, readError, readSnapshot } = personal;
  if (!snapshot) return <PlannerLoadState title="初回設定" message="個人の家事を読み込んでいます。" error={error} retry={refresh} onBack={back} />;
  if (snapshot.settings.setupCompleted && !startedSaving) return <Redirect href="/(tabs)" />;
  return <FirstRunSetupForm snapshot={snapshot} onExit={back} exitAccessibilityLabel="ホームに戻る" loadError={error}
    persist={async submission => {
      setStartedSaving(true);
      if (!readSnapshot()?.settings.setupCompleted) await completeFirstSetup(database, submission);
    }} onComplete={async () => {
      await refresh({ force: true });
      const error = readError();
      if (error) throw new Error(error);
      if (mounted.current) back();
    }} />;
}

function SettingsDataScreen({ section }: { section: SettingsCategory }) {
  const { snapshot, error: loadError, refresh, database, weatherOutcome } = usePersonalSettingsData();
  const workspace = useContext(WorkspaceContext);
  if (!snapshot) return <PlannerLoadState title={settingsTitles[section]} message="設定を読み込んでいます。" error={loadError} retry={refresh} onBack={() => returnFromSettings(section)} />;
  if (workspace?.userId && section === 'rhythm') return <AccountSettings key={workspace.userId} section={section} userId={workspace.userId} snapshot={snapshot} loadError={loadError} refresh={refresh} database={database} />;
  return <SettingsContent key={section === 'account' ? workspace?.userId ?? 'local' : section} section={section} snapshot={snapshot} loadError={loadError} refresh={refresh} database={database} weatherOutcome={weatherOutcome} />;
}

async function activateCurrentGoogleTaskAccount(database: SQLiteDatabase, subject: string) {
  const accounts = await import('@/features/google-sync/account-switch');
  return accounts.activateCurrentGoogleTaskAccount(database, subject);
}

function AccountSettings(props: { section: SettingsCategory; userId: string; snapshot: PersonalSettingsView; loadError: string | null; refresh: () => Promise<void>; database: SQLiteDatabase }) {
  const initial = useRef(props.snapshot); const { database, userId } = props; const focused = useRef(false);
  const [source, setSource] = useState<{ value: ReturnType<typeof createOwnerRhythmSettings>; formVersion: number } | null>(null);
  const [error, setError] = useState<string | null>(null); const [attempt, setAttempt] = useState(0);
  const unsettled = useRef(false); const onDraftChange = useCallback((value: boolean) => { unsettled.current = value; }, []);
  useLayoutEffect(() => { initial.current = props.snapshot; }, [props.snapshot]);
  useFocusEffect(useCallback(() => { if (focused.current && !unsettled.current) setAttempt(value => value + 1); else focused.current = true; }, []));
  useEffect(() => { let current = true;
    void (async () => {
      const user = await sharingSessionUser();
      if (!current) return;
      if (user?.uid !== userId) { setSource(null); throw new Error('設定を開くアカウントが変わりました。'); }
      const { nativePrivatePlannerPreferences } = await import('@/platform/sharing/private-calendar-secrets');
      const store = nativePrivatePlannerPreferences(userId); const saved = await store.read();
      const value = createOwnerRhythmSettings({ store, saved, local: initial.current.settings, timeZone: getDeviceTimeZone(),
        saveLocal: (next, expected) => updatePlannerSettings(database, next, expected) });
      let pendingError: string | null = null;
      try { await value.resume(); } catch { pendingError = '本人設定は保存済みですが、端末の予定には未反映です。最新の設定を確認して再試行してください。'; }
      if (current) {
        const visible = (settings: typeof value) => JSON.stringify([settings.settings(), settings.placement(), settings.timeZone()]);
        setSource(previous => ({ value, formVersion: previous ? previous.formVersion + Number(visible(previous.value) !== visible(value)) : 0 }));
        setError(pendingError);
      }
    })().catch(() => { if (current) setError('本人の生活リズムを読み込めませんでした。保存済みの内容は保持しています。'); });
    return () => { current = false; };
  }, [database, userId, attempt]);
  if (!source) return <PlannerLoadState header={<SettingsHeader title={settingsTitles[props.section]} onBack={() => returnFromSettings(props.section)} />} message="設定を読み込んでいます。" error={error} retry={async () => setAttempt(value => value + 1)} />;
  const timeZone = source.value.timeZone();
  return <SettingsContent key={source.formVersion} {...props} snapshot={{ ...props.snapshot, timeZone, today: sharedLocalDate(new Date(), timeZone),
    settings: { ...props.snapshot.settings, ...source.value.settings() } }} saveRhythm={source.value.save} capacity={source.value}
    rhythmRecoveryError={error} onDraftChange={onDraftChange} reloadRhythm={() => setAttempt(value => value + 1)} />;
}

function SettingsContent({ section = 'rhythm', snapshot, loadError, refresh, database, saveRhythm, reloadRhythm, onDraftChange, rhythmRecoveryError, capacity, weatherOutcome }: {
  section?: SettingsCategory;
  snapshot: PersonalSettingsView;
  loadError: string | null;
  refresh: (options?: { waitForWeather?: boolean; force?: boolean }) => Promise<void>;
  database: SQLiteDatabase;
  saveRhythm?: (value: PlannerRhythm) => Promise<void>;
  reloadRhythm?: () => void;
  rhythmRecoveryError?: string | null;
  onDraftChange?: (unsettled: boolean) => void;
  capacity?: ReturnType<typeof createOwnerRhythmSettings>;
  weatherOutcome?: 'disabled' | 'current' | 'adjusted' | 'unavailable';
}) {
  const workspace = useContext(WorkspaceContext);
  const v2 = workspace?.active?.protocol === 2;
  const colors = plannerColorsForScheme(useColorScheme());
  const draftParts = useRef({ rhythm: false, capacity: false });
  const onCapacityDraftChange = useCallback((value: boolean) => {
    draftParts.current.capacity = value; onDraftChange?.(value || draftParts.current.rhythm);
  }, [onDraftChange]);
  const capacityRef = useRef(capacity);
  useLayoutEffect(() => { capacityRef.current = capacity; }, [capacity]);
  const loadCapacity = useCallback(async () => ({ initial: capacity ? capacity.placement() : await loadPersonalPlacementPreferences(database),
    save: async (value: PersonalPlacementPreferences, expected: PersonalPlacementPreferences) => {
      if (capacityRef.current) await capacityRef.current.savePlacement(value, expected); else await savePersonalPlacementPreferences(database, value, expected);
      await refresh();
    } }), [capacity, database, refresh]);
  const [mode, setMode] = useState<FrequencyMode>(snapshot.settings.frequencyMode);
  const [restDays, setRestDays] = useState<Weekday[]>(snapshot.settings.restDays as Weekday[]);
  const [heavyLimit, setHeavyLimit] = useState(snapshot.settings.heavyDailyLimit);
  const [normalLimit, setNormalLimit] = useState(snapshot.settings.normalDailyLimit);
  const plannerDraftBase = useRef({ frequencyMode: snapshot.settings.frequencyMode, restDays: snapshot.settings.restDays,
    heavyDailyLimit: snapshot.settings.heavyDailyLimit, normalDailyLimit: snapshot.settings.normalDailyLimit });
  const [weatherUpdating, setWeatherUpdating] = useState(false);
  const [weatherRegion, setWeatherRegion] = useState(() => {
    const base = snapshot.settings.weatherLocation?.region ?? ''; const saved = weatherSearchDrafts.get(database);
    return saved?.base === base ? saved.query : base;
  });
  const [weatherSearchEnabled, setWeatherSearchEnabled] = useState(false);
  const [weatherCandidate, setWeatherCandidate] = useState<WeatherRegionCandidate | null>(null);
  const [weatherResultsDismissed, setWeatherResultsDismissed] = useState(false);
  const [weatherMessage, setWeatherMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const [notificationUpdating, setNotificationUpdating] = useState(false);
  const [notificationPermissionDenied, setNotificationPermissionDenied] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const notificationSettingsVisible = section === 'notifications' || section === 'general';
  const deviceNotificationPermission = useDeviceNotificationPermission(database, notificationSettingsVisible && snapshot.settings.notificationsEnabled, readNotificationPermission);
  const [accountTasksOpened, setAccountTasksOpened] = useState(false);
  const [googleSyncState, setGoogleSyncState] = useState<GoogleSyncState | null>(null);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleLoadStatus, setGoogleLoadStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [calendarAvailabilityState, setCalendarAvailabilityState] = useState<CalendarAvailabilityState | null>(null);
  const [calendarAvailabilityMessage, setCalendarAvailabilityMessage] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const operationLocks = useRef(new Set<string>());
  const beginOperation = (key: string) => {
    if (operationLocks.current.has(key)) return false;
    operationLocks.current.add(key);
    return true;
  };
  const endOperation = (key: string) => { operationLocks.current.delete(key); };

  const [googleMessage, setGoogleMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const weatherSuggestions = useMunicipalitySuggestions(weatherRegion, weatherSearchEnabled);
  const googleOAuthConfigured = getGoogleSyncOAuthConfig().configured;

  const googleReadGeneration = useRef(0);
  const cancelGoogleReads = useCallback(() => { googleReadGeneration.current++; }, []);
  const refreshGoogleState = useCallback(async () => {
    const generation = ++googleReadGeneration.current;
    const [state, calendarState] = await Promise.all([
      loadGoogleSyncState(database, LOCAL_HOUSEHOLD_ID),
      loadCalendarAvailabilityState(database),
    ]);
    const connected = await hasGoogleTasksSession(state?.accountSubject);
    if (generation !== googleReadGeneration.current) return;
    setGoogleSyncState(state);
    setGoogleConnected(connected && Boolean(state) && !state?.disconnected);
    setCalendarAvailabilityState(calendarState);
    setGoogleLoadStatus('ready');
  }, [database]);

  useEffect(() => {
    if (section !== 'tasks' && !(section === 'account' && accountTasksOpened)) return;
    // SQLite state is external persisted state; hydrate the screen after mount.
    const read = () => {
      const pending = refreshGoogleState(); const generation = googleReadGeneration.current;
      return pending.catch(() => {
        if (generation !== googleReadGeneration.current) return;
        setGoogleLoadStatus('error');
        setGoogleMessage({ text: 'Google同期の設定を読み込めませんでした。', kind: 'error' });
      });
    };
    const stop = subscribeToGoogleAccountChanges(database, () => { setGoogleMessage(null); void read(); });
    void read();
    return () => { stop(); cancelGoogleReads(); };
  }, [section, accountTasksOpened, database, refreshGoogleState, cancelGoogleReads]);

  const connectGoogle = async () => {
    if (googleBusy) return;
    if (!beginOperation('google')) return;
    setGoogleBusy(true);
    setGoogleMessage(null);
    try {
      const subject = await authorizeGoogleTasks();
      await activateCurrentGoogleTaskAccount(database, subject);
      await configurePersonalGoogleTaskSync(database, true, { accountSubject: subject });
      setGoogleConnected(true);
      await refreshGoogleState();
      try { await registerGoogleSyncBackgroundTask(); } catch { /* Foreground sync remains available. */ }
      const result = await syncGoogleTasks(database, { force: true, expectedAccountSubject: subject });
      await refreshGoogleState();
      setGoogleMessage(result.kind === 'success'
        ? result.skipped
          ? { text: 'Googleには接続しましたが、同期は実行されていません。同期設定を確認してください。', kind: 'error' }
          : { text: 'Google Tasksに接続し、同期しました。', kind: 'success' }
        : { text: syncFailureMessage(result.kind, result.code), kind: 'error' });
    } catch (cause) {
      setGoogleMessage({ text: cause instanceof Error && cause.name === 'GoogleAuthorizationCancelledError'
        ? 'Googleとの接続をキャンセルしました。'
        : 'Google Tasksに接続できませんでした。もう一度お試しください。', kind: 'error' });
      await refreshGoogleState().catch(() => undefined);
    } finally {
      endOperation('google'); setGoogleBusy(false);
    }
  };

  const toggleGoogleSync = async (enabled: boolean, selectedSubject?: string) => {
    if (googleBusy) return;
    if (!beginOperation('google')) return;
    setGoogleBusy(true);
    setGoogleMessage(null);
    try {
      let subject = selectedSubject ?? googleSyncState?.accountSubject;
      if (enabled) {
        subject = section === 'account' && selectedSubject ? selectedSubject : await authorizeGoogleTasks(subject);
        await activateCurrentGoogleTaskAccount(database, subject);
      }
      const saved = await configurePersonalGoogleTaskSync(database, enabled, { accountSubject: subject });
      setGoogleSyncState(saved);
      if (enabled) {
        try { await registerGoogleSyncBackgroundTask(); } catch { /* Foreground sync remains available. */ }
        if (section === 'account') {
          const generation = googleReadGeneration.current;
          void syncGoogleTasks(database, { force: true, expectedAccountSubject: subject }).then(async () => {
            if (generation === googleReadGeneration.current) await refreshGoogleState();
          }).catch(() => { /* The coordinator keeps pending changes and its retry status. */ });
          return;
        }
        const result = await syncGoogleTasks(database, { force: true, expectedAccountSubject: subject });
        await refreshGoogleState();
        setGoogleMessage(result.kind === 'success'
          ? result.skipped
            ? { text: '同期を有効にしましたが、同期は実行されていません。同期状態を確認してください。', kind: 'error' }
            : { text: 'Google Tasksとの同期を有効にしました。', kind: 'success' }
          : { text: syncFailureMessage(result.kind, result.code), kind: 'error' });
      } else {
        await unregisterGoogleSyncBackgroundTask().catch(() => undefined);
        await refreshGoogleState();
        setGoogleMessage({ text: 'Google Tasksとの自動同期を一時停止しました。', kind: 'success' });
      }
    } catch {
      setGoogleMessage({ text: enabled ? '同期を有効にできませんでした。Googleとの再接続をお試しください。' : '同期を停止できませんでした。', kind: 'error' });
      await refreshGoogleState().catch(() => undefined);
    } finally {
      endOperation('google'); setGoogleBusy(false);
    }
  };

  const syncGoogleNow = async () => {
    if (googleBusy || !googleSyncState?.enabled) return;
    if (!beginOperation('google')) return;
    setGoogleBusy(true);
    setGoogleMessage(null);
    try {
      let subject = googleSyncState.accountSubject;
      if (googleSyncState.status === 'authRequired' || !subject || !await hasGoogleTasksSession(subject)) {
        const { changeGoogleAccount } = await import('@/features/google-sync/account-switch');
        const selected = await changeGoogleAccount(database);
        subject = await authorizeGoogleTasks(selected);
        // Switching accounts restores that account's saved controls (or a paused
        // new connection). This explicit retry also enables Tasks for that account.
        await configurePersonalGoogleTaskSync(database, true, { accountSubject: subject });
      }
      const result = await syncGoogleTasks(database, { force: true, expectedAccountSubject: subject });
      await refreshGoogleState();
      setGoogleMessage(result.kind === 'success'
        ? result.skipped
          ? { text: '同期は実行されていません。同期状態を確認してから再試行してください。', kind: 'error' }
          : { text: `同期しました（新規 ${result.created ?? 0}件・更新 ${result.updated ?? 0}件${result.imported ? `・Googleから完了 ${result.imported}件` : ''}）。`, kind: 'success' }
        : { text: syncFailureMessage(result.kind, result.code), kind: 'error' });
    } catch {
      setGoogleMessage({ text: '同期できませんでした。Googleとの再接続をお試しください。', kind: 'error' });
      await refreshGoogleState().catch(() => undefined);
    } finally {
      endOperation('google'); setGoogleBusy(false);
    }
  };

  const toggleCalendarAvailability = async (enabled: boolean) => {
    if (googleBusy) return;
    if (!beginOperation('google')) return;
    setGoogleBusy(true);
    setCalendarAvailabilityMessage(null);
    try {
      const granted = await configureGoogleCalendarAvailability(database, enabled, authorizeGoogleCalendarAvailability);
      // OFF also regenerates without Calendar input before pushing any changed due dates.
      const result = await syncGoogleTasks(database, { force: true });
      await refreshGoogleState();
      setCalendarAvailabilityMessage(enabled && !granted
        ? 'カレンダー権限が許可されませんでした。Google Tasksの同期は引き続き利用できます。'
        : result.kind !== 'success'
          ? 'カレンダー設定を保存しました。Google Tasksの同期状態も確認してください。'
          : enabled ? 'カレンダー連携を有効にしました。取得状態を確認してください。' : 'カレンダーによる家事日調整を停止しました。');
    } catch {
      setCalendarAvailabilityMessage('カレンダー設定を更新できませんでした。Google Tasksの同期状態は別に確認できます。');
      await refreshGoogleState().catch(() => undefined);
    } finally { endOperation('google'); setGoogleBusy(false); }
  };

  const disconnectGoogle = async () => {
    if (googleBusy || !googleSyncState) return;
    if (!beginOperation('google')) return;
    setGoogleBusy(true);
    setGoogleMessage(null);
    try {
      const saved = await configurePersonalGoogleTaskSync(database, false, { accountSubject: googleSyncState.accountSubject, disconnect: true });
      cancelGoogleReads();
      setGoogleSyncState(saved);
      setGoogleConnected(false);
      setCalendarAvailabilityState(previous => previous && { ...previous, enabled: false });
      void unregisterGoogleSyncBackgroundTask().catch(() => undefined);
      setGoogleMessage({ text: 'この端末の家事同期を解除しました。Google Tasks上の家事は残しています。', kind: 'success' });
    } catch (cause) {
      await refreshGoogleState().catch(() => undefined);
      setGoogleMessage({ text: cause instanceof GoogleAccountMismatchError ? 'Googleアカウントが変わりました。' : '家事同期の設定を変更できませんでした。', kind: 'error' });
    } finally {
      endOperation('google'); setGoogleBusy(false);
    }
  };

  const toggleRestDay = (day: Weekday) => {
    const current = currentDraft.current.restDays;
    changeSettings({ restDays: current.includes(day) ? current.filter(value => value !== day) : [...current, day].sort() as Weekday[] });
  };

  type Rhythm = typeof plannerDraftBase.current;
  const currentDraft = useRef<Rhythm>({ frequencyMode: mode, restDays, heavyDailyLimit: heavyLimit, normalDailyLimit: normalLimit });
  const autosave = useSettingsAutosave<Partial<Rhythm>>(async patch => {
    const rhythm = { ...plannerDraftBase.current, ...patch };
    if (JSON.stringify(rhythm) !== JSON.stringify(plannerDraftBase.current)) {
      if (saveRhythm) await saveRhythm(rhythm);
      else await updatePlannerSettings(database, rhythm, plannerDraftBase.current);
      plannerDraftBase.current = rhythm;
    }
    await refresh();
  });
  useLayoutEffect(() => {
    draftParts.current.rhythm = !['idle', 'saved'].includes(autosave.status.phase); onDraftChange?.(draftParts.current.rhythm || draftParts.current.capacity);
  }, [onDraftChange, autosave.status.phase]);
  const changeSettings = (patch: Partial<Rhythm>) => {
    currentDraft.current = { ...currentDraft.current, ...patch };
    const value = currentDraft.current;
    setMode(value.frequencyMode); setRestDays(value.restDays as Weekday[]); setHeavyLimit(value.heavyDailyLimit); setNormalLimit(value.normalDailyLimit);
    autosave.enqueue(patch);
  };
  const accountActions = { database, disabled: googleBusy, acquire: () => {
    if (!beginOperation('google')) return false; setGoogleBusy(true); return true;
  }, release: () => { endOperation('google'); setGoogleBusy(false); }, onChanged: async () => { setGoogleMessage(null); },
  prepare: async () => Boolean(await autosave.flush() && !draftParts.current.rhythm && !draftParts.current.capacity) };

  const openAccountTasks = useCallback(() => setAccountTasksOpened(true), []);

  const selectWeatherRegion = async (candidate: WeatherRegionCandidate) => {
    if (weatherUpdating) return;
    if (!beginOperation('weather')) return;
    setWeatherCandidate(candidate);
    setWeatherUpdating(true);
    setWeatherMessage(null);
    try {
      await saveWeatherLocation(database, municipalityWeatherLocation(candidate, weatherRegion));
      await refresh({ waitForWeather: true });
      setWeatherRegion(weatherRegion.trim());
      setWeatherResultsDismissed(false);
      setWeatherMessage({ text: `天気を調べる地域を「${candidate.label}」に設定しました。`, kind: 'success' });
    } catch (cause) {
      setWeatherCandidate(null);
      setWeatherMessage({ text: cause instanceof Error ? cause.message : '地域を保存できませんでした。', kind: 'error' });
    } finally {
      endOperation('weather'); setWeatherUpdating(false);
    }
  };

  const disableWeather = async () => {
    if (!beginOperation('weather')) return;
    setWeatherUpdating(true);
    setWeatherMessage(null);
    try {
      await clearWeatherLocation(database);
      await refresh({ waitForWeather: true });
      setWeatherResultsDismissed(true);
      setWeatherCandidate(null);
      setWeatherMessage({ text: '天気連動を停止し、保存した地域を削除しました。', kind: 'success' });
    } catch (cause) {
      setWeatherMessage({ text: cause instanceof Error ? cause.message : '天気連動を停止できませんでした。', kind: 'error' });
    } finally {
      endOperation('weather'); setWeatherUpdating(false);
    }
  };

  const retryWeather = async () => {
    if (!beginOperation('weather')) return;
    setWeatherUpdating(true); setWeatherMessage(null);
    try { await refresh({ waitForWeather: true, force: true }); }
    catch { setWeatherMessage({ text: '天気予報を取得できませんでした。', kind: 'error' }); }
    finally { endOperation('weather'); setWeatherUpdating(false); }
  };

  const toggleNotifications = async (enabled: boolean) => {
    if (!beginOperation('notifications')) return;
    setNotificationUpdating(true);
    setNotificationMessage(null);
    try {
      if (enabled && !(await notificationGateway.requestPermission())) {
        setNotificationPermissionDenied(true);
        setNotificationMessage({ text: '通知は有効になりませんでした。端末の設定から許可できます。', kind: 'error' });
        return;
      }
      await setNotificationsEnabled(database, enabled);
      setNotificationPermissionDenied(false);
      await refresh();
      setNotificationMessage({ text: enabled ? '通知を有効にしました。' : '通知をオフにしました。', kind: 'success' });
    } catch {
      setNotificationMessage({ text: '通知設定を変更できませんでした。', kind: 'error' });
    } finally {
      endOperation('notifications'); setNotificationUpdating(false);
    }
  };

  const changeNotificationTime = async (minute: number) => {
    if (minute === snapshot.settings.notificationHour * 60 + snapshot.settings.notificationMinute || !beginOperation('notifications')) return;
    setNotificationUpdating(true); setNotificationMessage(null);
    try { await setHouseworkNotificationTime(database, minute); await refresh(); }
    catch { setNotificationMessage({ text: '通知時刻を変更できませんでした。', kind: 'error' }); }
    finally { endOperation('notifications'); setNotificationUpdating(false); }
  };

  const calendarAvailabilityForm = !snapshot.sharing ? <View style={{ gap: 12 }}>
            <View style={styles.notificationRow}>
              <View style={styles.limitCopy}>
                <Text style={section === 'account' ? typography.body : styles.featureTitle}>{section === 'account' ? '空き時間を家事配分に使う' : 'Googleカレンダーの予定を家事日調整に使う'}</Text>
                <Text style={styles.hint}>{section === 'account' ? googleSyncState?.enabled ? 'メインカレンダーの空き時間を使います。' : 'Google Tasksに接続すると使えます。' : '予定のタイトルや内容は取得せず、予定が入っている時間帯だけを使って家事日を調整します。'}</Text>
                {section !== 'account' ? <Text style={styles.hint}>現在はGoogleアカウントのメインカレンダーを対象にします。</Text> : null}
              </View>
              <SettingsCheckbox accessibilityLabel="Googleカレンダーの予定を家事日調整に使う"
                value={Boolean(calendarAvailabilityState?.enabled)} disabled={googleBusy || !googleSyncState?.enabled}
                onValueChange={(value) => void toggleCalendarAvailability(value)} />
            </View>
            {section !== 'account' || calendarAvailabilityState?.enabled || calendarAvailabilityState?.status === 'permissionRequired' || calendarAvailabilityState?.status === 'error' ? <FeatureStatus title="カレンダー連携"
              status={calendarAvailabilityState?.status === 'permissionRequired' ? '追加の許可が必要'
                : !calendarAvailabilityState?.enabled ? '無効'
                  : calendarAvailabilityState.status === 'retryPending' ? '取得失敗・再試行待ち'
                    : calendarAvailabilityState.status === 'syncing' ? '取得中'
                      : calendarAvailabilityState.status === 'error' ? '取得エラー' : '有効'}
              detail={`最終取得：${formatSyncTimestamp(calendarAvailabilityState?.lastSuccessfulSyncAt)}。36時間を超えた情報は使いません。`} /> : null}
            {calendarAvailabilityState?.status === 'permissionRequired' ? (
              <AppButton title="カレンダーの許可を確認" onPress={() => void toggleCalendarAvailability(true)} disabled={googleBusy || !googleSyncState?.enabled} />
            ) : null}
            {calendarAvailabilityState?.lastErrorCode === 'calendar_api_not_enabled' ? (
              <Text style={styles.error}>Google Calendar APIが無効です。Google Cloudのプロジェクト設定で有効にしてください。</Text>
            ) : null}
            {calendarAvailabilityMessage ? <Text style={styles.hint}>{calendarAvailabilityMessage}</Text> : null}

  </View> : null;
  const googleTasksForm = section === 'account' ? <AccountPersonalGoogleTasks state={googleSyncState} shared={v2} loaded={googleLoadStatus === 'ready'} busy={googleBusy}
    error={googleLoadStatus === 'error' ? '連携設定を読み込めませんでした。' : googleMessage?.kind === 'error' ? googleMessage.text : null}
    onToggle={(value, subject) => void toggleGoogleSync(value, subject)} onSync={() => void syncGoogleNow()} /> : <View style={{ gap: 12 }}>
        {googleLoadStatus === 'error' ? <Text accessibilityRole="alert" style={styles.error}>連携設定を読み込めませんでした。</Text> : null}
        <FeatureStatus
          title="Google Tasks"
          status={googleLoadStatus === 'loading' ? '確認中…' : googleLoadStatus === 'error' ? '確認できません' : googleConnected ? '接続済み' : googleSyncState?.enabled ? '再認証が必要' : googleOAuthConfigured ? '未接続' : 'OAuth設定待ち'}
          detail="家事Plannerの名前と予定日をGoogle Tasksへ反映し、完了・完了の取り消しを双方へ同期します。取り消した家事は未完了に戻り、次回予定も再計算します。"
        />
        {!googleOAuthConfigured ? (
          <Text style={styles.hint}>OAuth client IDが未設定です。docs/google-sync-setup.mdの手順後、ネイティブ開発ビルドを作り直してください。</Text>
        ) : null}
        {googleConnected || googleSyncState?.enabled ? (
          <>
            <View style={styles.notificationRow}>
              <View style={styles.limitCopy}>
                <Text style={styles.featureTitle}>自動同期</Text>
                <Text style={styles.hint}>{googleSyncState?.enabled ? '通常は1日経過後、失敗時は約1時間経過後に再試行できます。アプリ復帰時やOSが許可したバックグラウンド実行で確認します。' : '自動同期は一時停止中です。'}</Text>
              </View>
              <SettingsCheckbox accessibilityLabel="Google Tasksの自動同期" value={Boolean(googleSyncState?.enabled)} disabled={googleBusy} onValueChange={(value) => void toggleGoogleSync(value)} />
            </View>
            <FeatureStatus
              title="同期状態"
              status={googleSyncState?.enabled ? googleSyncStatusLabel(googleSyncState.status) : '一時停止'}
              detail={`最終同期：${formatSyncTimestamp(googleSyncState?.lastSuccessfulSyncAt)}。iOS・Androidのバックグラウンド実行はOSの判断で遅れることがあります。`}
            />
            {calendarAvailabilityForm}
            <View style={styles.googleActions}>
              <SettingsAction placement="page" title={googleBusy ? '同期中…' : googleSyncState?.status === 'authRequired' ? '再接続して同期' : '今すぐ同期'} onPress={() => void syncGoogleNow()} disabled={googleBusy || !googleSyncState?.enabled} />
              <SettingsAction intent="destructive" title="接続解除" onPress={() => void disconnectGoogle()} disabled={googleBusy} />
            </View>
          </>
        ) : (
          <SettingsAction placement="page" title={googleBusy ? '接続中…' : googleLoadStatus === 'loading' ? '接続状況を確認中…' : 'Googleと接続'} onPress={() => void connectGoogle()} disabled={googleBusy || googleLoadStatus !== 'ready' || !googleOAuthConfigured} />
        )}
        <Text style={styles.hint}>同期する家事名と予定日をGoogleへ送信します。接続解除時もGoogle Tasks上の既存家事は削除しません。Google Tasks権限は広い範囲に適用されるため、信頼できるGoogleアカウントで接続してください。</Text>
        {googleMessage ? <Text style={googleMessage.kind === 'success' ? styles.success : styles.error}>{googleMessage.text}</Text> : null}
  </View>;

  return (
    <Page keyboardAware={section === 'general' || section === 'weather'} header={<SettingsHeader title={settingsTitles[section]} onBack={() => void autosave.navigate(() => returnFromSettings(section))} />}>
      {autosave.status.phase === 'error' ? <Card><Text accessibilityRole="alert" style={styles.error}>{autosave.status.error}</Text><AppButton title="保存を再試行" variant="quiet" compact onPress={() => void autosave.flush()} />
        {reloadRhythm ? <AppButton title="未保存の入力を破棄して設定を読み直す" variant="quiet" compact onPress={() => {
          for (const key of Object.keys(currentDraft.current) as (keyof typeof currentDraft.current)[]) autosave.remove(key);
          reloadRhythm();
        }} /> : null}</Card> : null}
      {loadError ? <Card><Text style={styles.error}>{loadError}</Text></Card> : null}
      {rhythmRecoveryError ? <Card><Text accessibilityRole="alert" style={styles.error}>{rhythmRecoveryError}</Text>
        <AppButton title="端末への反映を再試行" variant="quiet" compact onPress={() => reloadRhythm?.()} /></Card> : null}


      {section === 'rhythm' ? <PersonalCapacitySettings load={loadCapacity} today={snapshot.today ?? localDateFromDate(new Date())} restDays={restDays} onDraftChange={onCapacityDraftChange}
        limits={<><View style={[styles.rhythmLimitRow, { borderTopColor: colors.border }]}><Text style={styles.rhythmLabel}>重い家事</Text>
          <Counter value={heavyLimit} onChange={heavyDailyLimit => changeSettings({ heavyDailyLimit })} maximum={10} label="重い家事の上限" />
        </View><View style={[styles.rhythmLimitRow, { borderTopColor: colors.border }]}><Text style={styles.rhythmLabel}>普通の家事</Text>
          <Counter value={normalLimit} onChange={normalDailyLimit => changeSettings({ normalDailyLimit })} maximum={20} label="普通の家事の上限" />
        </View></>}>{capacityForm => <View style={styles.rhythmSection}>
        <Text style={styles.rhythmHeading}>休日</Text>
        <View style={styles.weekdayRow}>
          {weekdays.map((day) => {
            const selected = restDays.includes(day.id);
            return (
              <Pressable
                key={day.id}
                accessibilityRole="button"
                accessibilityLabel={`${day.label}曜日`}
                accessibilityState={{ selected }}
                onPress={() => toggleRestDay(day.id)}
                style={({ pressed }) => [styles.weekdayChip, { borderColor: colors.accent, backgroundColor: selected ? colors.accentSoft : colors.surface }, pressed && styles.weekdayChipPressed]}
              >
                <Text style={[styles.weekdayChipText, selected && styles.weekdayChipTextSelected, { color: colors.accent }]}>{day.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>普段の休みを選択</Text>
        <SettingsPanel><View style={styles.rhythmFrequency}><Text style={styles.rhythmLabel}>家事の頻度</Text>
          <SettingsSegments wide options={modeOptions} value={mode} onValueChange={frequencyMode => changeSettings({ frequencyMode })} />
        </View></SettingsPanel>
        {capacityForm}
      </View>}</PersonalCapacitySettings> : null}

      <SettingsSection section={section} id="tasks">{googleTasksForm}</SettingsSection>
      <SettingsSection section={section} id="calendar"><PersonalGoogleCalendarSettings database={database} /></SettingsSection>

      <SettingsSection section={section} id="appearance"><AppearanceControls embedded /></SettingsSection>
      <SettingsSection section={section} id="notifications">
        <SettingsCheckbox label={v2 ? '個人家事の通知' : '家事の通知'} description="開始日・期限などの未完了家事をまとめて通知。"
          accessibilityLabel="家事の通知を受け取る" value={snapshot.settings.notificationsEnabled} disabled={notificationUpdating} onValueChange={value => void toggleNotifications(value)} />
        {snapshot.settings.notificationsEnabled ? <CalendarField label="家事の通知時刻" mode="time" date={snapshot.today ?? localDateFromDate(new Date())}
          minute={snapshot.settings.notificationHour * 60 + snapshot.settings.notificationMinute} commitOnDone borderless disabled={notificationUpdating}
          onMinute={minute => { void changeNotificationTime(minute); }} /> : null}
        {notificationMessage ? <Text accessibilityLiveRegion="polite" style={notificationMessage.kind === 'success' ? styles.success : styles.error}>{notificationMessage.text}</Text> : null}
        {deviceNotificationPermission === false && !notificationPermissionDenied ? <Text accessibilityLiveRegion="polite" style={styles.error}>端末の通知がオフです。</Text> : null}
        {notificationPermissionDenied || deviceNotificationPermission === false ? <NotificationPermissionRecovery scope={database} disabled={notificationUpdating}
          checkPermission={readNotificationPermission} onGranted={notificationPermissionDenied ? () => toggleNotifications(true) : undefined} /> : null}
        <CalendarNotificationSettings database={database} />
        {v2 ? <><View style={[styles.divider, { backgroundColor: colors.border }]} /><GeneralGroupNotifications /></> : null}
      </SettingsSection>

      {!snapshot.sharing ? <SettingsSection section={section} id="weather">
        <Text style={styles.hint}>{snapshot.settings.weatherLocation
          ? section === 'general' ? `対象地域：${snapshot.settings.weatherLocation.displayName}` : `対象地域：${snapshot.settings.weatherLocation.displayName}。予報更新時に、サーバー経由でMET Norwayへ地域の代表座標を送信します。`
          : '市区町村を選ぶと、天気に合わせて洗濯予定を調整します。端末の位置情報は使いません。'}</Text>
        <TextInput
          value={weatherRegion}
          editable={!weatherUpdating}
          onChangeText={(value) => {
            setWeatherRegion(value);
            weatherSearchDrafts.set(database, { base: snapshot.settings.weatherLocation?.region ?? '', query: value });
            setWeatherSearchEnabled(true);
            setWeatherResultsDismissed(false);
            setWeatherCandidate(null);
            setWeatherMessage(null);
          }}
          placeholder="市区町村名を入力（例：横浜市）"
          placeholderTextColor={palette.muted}
          style={[styles.regionInput, { borderColor: colors.border, backgroundColor: colors.surface }]}
          accessibilityLabel="天気予報に使う市区町村"
          returnKeyType="done"
        />
        <Text style={styles.hint}>{section === 'general' ? '地域の代表座標を天気配信元へ送信します。' : '入力すると候補を検索します。候補は「市区町村、都道府県」で表示します。'}</Text>
        <View style={styles.weatherActions}>
          {snapshot.settings.weatherLocation ? (
            <SettingsAction title="連動を解除" intent="destructive" onPress={() => void disableWeather()} disabled={weatherUpdating} />
          ) : null}
        </View>
        {weatherSuggestions.candidates.length > 0 && !weatherResultsDismissed ? (
          <View style={styles.regionResults}>
            <Text style={styles.label}>候補を選択</Text>
            {weatherSuggestions.candidates.map((candidate) => (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                accessibilityLabel={`地域 ${candidate.label} を選択`}
                accessibilityState={{ selected: weatherCandidate?.id === candidate.id }}
                disabled={weatherUpdating}
                onPress={() => void selectWeatherRegion(candidate)}
                style={({ pressed }) => [styles.regionCandidate, weatherCandidate?.id === candidate.id && styles.regionCandidateSelected, pressed && styles.regionCandidatePressed]}
              >
                <Text style={styles.regionCandidateText}>{candidate.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {weatherSuggestions.status === 'empty' && !weatherResultsDismissed
          ? <Text style={styles.hint}>市区町村が見つかりませんでした。市区町村名を変えてください。</Text>
          : null}
        {weatherMessage ? (
          <Text style={weatherMessage.kind === 'success' ? styles.success : styles.error}>{weatherMessage.text}</Text>
        ) : null}
        {snapshot.settings.weatherLocation && weatherOutcome === 'unavailable' ? <View style={{ gap: 4 }}>
          {weatherMessage?.kind !== 'error' ? <Text accessibilityLiveRegion="polite" style={styles.hint}>天気予報を取得できませんでした。</Text> : null}
          <SettingsAction title="天気予報を再取得" intent="auxiliary" onPress={() => void retryWeather()} disabled={weatherUpdating} />
        </View> : null}
        {section === 'weather' && snapshot.settings.weatherLocation ? <WeatherAttribution /> : null}
      </SettingsSection> : null}

      <SettingsSection section={section} id="birthdays"><BirthdaySettings database={database} today={snapshot.today} timeZone={snapshot.timeZone} embedded={section === 'general'} /></SettingsSection>
      <SettingsSection section={section} id="credits"><DataCredits inline /></SettingsSection>
      <SettingsSection section={section} id="account">
        <AccountOperationContext.Provider value={{ busy: googleBusy, acquire: accountActions.acquire, release: accountActions.release }}>
          <AccountConnections database={database} settings={snapshot.settings} personalTasks={googleTasksForm} calendarOptions={calendarAvailabilityForm}
            onTasksOpen={openAccountTasks} />
          {subscriptionRequired ? <SettingsList><SettingsRow title="月額契約" onPress={() => void autosave.navigate(() => router.push('/subscription'))} /></SettingsList> : null}
          <View style={{ gap: 8, marginTop: 16 }}><GoogleAccountSwitch {...accountActions} /><AccountSignOut {...accountActions} /></View>
        </AccountOperationContext.Provider>
      </SettingsSection>
      {section === 'diagnostics' && typeof __DEV__ !== 'undefined' && __DEV__ ? <BackgroundSyncDiagnostics /> : null}
      {section === 'general' && typeof __DEV__ !== 'undefined' && __DEV__ ? <SettingsList>
        <SettingsRow title="開発検査" onPress={() => router.push('/development')} />
        <SettingsRow title="バックグラウンド同期の実行記録" onPress={() => router.push({ pathname: '/settings', params: { section: 'diagnostics' } })} />
      </SettingsList> : null}
    </Page>
  );
}

function Counter({ value, onChange, maximum, label }: {
  value: number; onChange: (value: number) => void; maximum: number; label: string;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  return (
    <View style={styles.counter}>
      <Pressable onPress={() => onChange(Math.max(1, value - 1))} disabled={value <= 1}
        accessibilityRole="button" accessibilityLabel={`${label}を減らす`} accessibilityState={{ disabled: value <= 1 }}>
        <Text style={[styles.counterButton, { color: value <= 1 ? colors.disabled : colors.accent }]}>−</Text>
      </Pressable>
      <Text style={styles.counterValue}>{value}<Text style={styles.counterUnit}> 件</Text></Text>
      <Pressable onPress={() => onChange(Math.min(maximum, value + 1))} disabled={value >= maximum}
        accessibilityRole="button" accessibilityLabel={`${label}を増やす`} accessibilityState={{ disabled: value >= maximum }}>
        <Text style={[styles.counterButton, { color: value >= maximum ? colors.disabled : colors.accent }]}>＋</Text>
      </Pressable>
    </View>
  );
}

function FeatureStatus({ title, status, detail }: { title: string; status: string; detail: string }) {
  return (
    <View style={styles.feature}>
      <View style={styles.featureTop}><Text style={styles.featureTitle}>{title}</Text><SettingsStatus>{status}</SettingsStatus></View>
      <Text style={styles.hint}>{detail}</Text>
    </View>
  );
}

function googleSyncStatusLabel(status: GoogleSyncState['status']): string {
  if (status === 'syncing') return '同期中';
  if (status === 'retryPending') return '再試行待ち';
  if (status === 'authRequired') return '再認証が必要';
  if (status === 'error') return 'エラー';
  return '同期済み';
}

function formatSyncTimestamp(value: string | undefined): string {
  if (!value) return 'まだありません';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('ja-JP') : 'まだありません';
}

function syncFailureMessage(kind: 'retry' | 'authRequired' | 'error', code?: string): string {
  if (code === 'google_account_mismatch') return '以前連携したGoogleアカウントを選んで再接続してください。保存済みの家事との紐付けは保持しています。';
  if (code === 'err_internal_sqlite_error') return '端末内の同期情報を処理できませんでした。もう一度同期してください。';
  if (code === 'task_create_result_pending') return '同期結果を確認できていません。もう一度同期してください。';
  if (kind === 'retry') return '一時的な通信エラーです。約1時間後に再試行します。';
  if (kind === 'authRequired') return 'Googleへの再認証が必要です。Googleと再接続してください。';
  if (code === 'oauth_not_configured') return 'Google連携の準備ができていません。';
  return '同期できませんでした。もう一度お試しください。';
}



const styles = StyleSheet.create({
  accordionChevron: { color: palette.accent, fontSize: 23, fontWeight: '700', lineHeight: 28, transform: [{ rotate: '0deg' }] },
  accordionChevronExpanded: { transform: [{ rotate: '180deg' }] },
  label: { ...typography.label, color: palette.ink, fontWeight: '700' },
  rhythmSection: { gap: 12 },
  rhythmFrequency: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 62 },
  rhythmLabel: { ...typography.label, color: palette.ink }, rhythmHeading: { ...typography.label, color: palette.ink, fontWeight: '600' },
  rhythmLimitRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: palette.border },
  weekdayRow: { width: '100%', flexDirection: 'row', flexWrap: 'nowrap', gap: 5 },
  weekdayChip: { flex: 1, minWidth: 0, minHeight: 44, borderRadius: 999, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 0 },
  weekdayChipSelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  weekdayChipPressed: { opacity: 0.75 },
  weekdayChipText: { ...typography.label, color: palette.muted, fontWeight: '600' },
  weekdayChipTextSelected: { color: palette.accent, fontWeight: '700' },
  hint: { ...typography.caption, color: palette.muted },
  limitRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  limitCopy: { flex: 1, gap: 3 },

  counter: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: palette.background, borderRadius: 12 },
  counterButton: { ...typography.section, minWidth: 40, lineHeight: 44, color: palette.accent, fontWeight: '700', textAlign: 'center' },
  counterValue: { ...typography.label, minWidth: 18, color: palette.ink, textAlign: 'center', fontWeight: '700' },
  counterUnit: { ...typography.caption, color: palette.muted, fontWeight: '400' },
  choreGroup: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  choreGroupHeader: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  choreGroupTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  groupCount: { ...typography.caption, color: palette.muted, fontWeight: '600' },
  choreSettingRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  choreSettingCopy: { flex: 1, gap: 2 },
  choreSettingTitle: { ...typography.subheading, color: palette.ink, fontWeight: '600' },
  chevron: { color: palette.accent, fontSize: 22 },
  regionInput: { ...typography.body, minHeight: 54, borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, color: palette.ink, backgroundColor: palette.background },
  regionResults: { gap: 7 },
  regionCandidate: { minHeight: 42, borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, justifyContent: 'center', backgroundColor: palette.surface },
  regionCandidatePressed: { backgroundColor: palette.accentSoft },
  regionCandidateSelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  regionCandidateText: { ...typography.label, color: palette.ink, fontWeight: '600' },
  feature: { gap: 5, paddingVertical: 2 },
  notificationRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  weatherActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  googleActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  featureTop: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  featureTitle: { ...typography.control, color: palette.ink, fontWeight: '700' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: palette.border, marginVertical: 1 },
  footer: { ...typography.caption, color: palette.muted, textAlign: 'center' },
  error: { ...typography.label, color: palette.warning },
  success: { ...typography.label, color: palette.accent, fontWeight: '600' },
});
