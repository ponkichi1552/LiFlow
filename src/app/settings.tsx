import { Chevron } from '@/components/chevron';
import { useSettingsAutosave } from '@/features/settings/use-settings-autosave';
import { BackgroundSyncDiagnostics } from '@/features/google-sync/background-diagnostics';
import { FormTextInput as TextInput } from '../components/form-text-input';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SettingsSwitch as Switch } from '@/components/settings-switch';

import { AppButton, BackButton, Card, ChoiceChip, Page, ScreenHeading, palette, typography } from '@/components/planner-ui';
import { GroupManagementLinks } from '@/features/sharing/group-management-links';
import { ChoreSettingsSources } from '@/features/settings/chore-settings-sources';
import { AccordionSection } from '@/components/accordion-section';
import { BirthdaySettings } from '@/features/calendar/birthday-settings';
import { DataCredits } from '@/components/data-credits';
import type { FrequencyMode } from '@/domain/chores/types';
import type { Weekday } from '@/domain/shared/types';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePlannerData } from '@/hooks/use-planner-data';
import { WorkspaceContext } from '@/contexts/workspace-context';
import type { WeatherRegionCandidate } from '@/features/weather/open-meteo-geocoder';
import { useMunicipalitySuggestions } from '@/features/weather/use-municipality-suggestions';
import {
  clearWeatherLocation,
  loadGoogleSyncState,
  loadCalendarAvailabilityState,
  LOCAL_HOUSEHOLD_ID,
  saveGoogleSyncState,
  saveWeatherLocation,
  setNotificationsEnabled,
  updatePlannerSettings,
} from '@/platform/storage/repository';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { ExpoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';
import { getGoogleSyncOAuthConfig } from '@/features/google-sync/google-oauth-config';
import type { GoogleSyncState } from '@/features/google-sync/contracts';
import { syncGoogleTasks } from '@/features/google-sync/coordinator';
import { registerGoogleSyncBackgroundTask, unregisterGoogleSyncBackgroundTask } from '@/features/google-sync/background-task';
import { authorizeGoogleCalendarAvailability, authorizeGoogleTasks, disconnectGoogleTasksSession, getGoogleTasksAccessToken, hasGoogleTasksSession } from '@/platform/google-tasks/google-sign-in-gateway';
import type { CalendarAvailabilityState } from '@/features/google-sync/calendar-availability';
import { configureGoogleCalendarAvailability } from '@/features/google-sync/calendar-settings';
import { hasOtherGoogleWorkspaceConnections, sharingSessionUser } from '@/platform/sharing/workspaces';
import { getDeviceTimeZone } from '@/features/google-sync/calendar-availability';
import { createOwnerRhythmSettings, type PlannerRhythm } from '@/features/settings/owner-rhythm-settings';

const modeOptions: { id: FrequencyMode; label: string; detail: string }[] = [
  { id: 'frequent', label: 'こまめ', detail: '短めの周期' },
  { id: 'balanced', label: '適度', detail: '標準の周期' },
  { id: 'relaxed', label: '少なめ', detail: 'ゆったり' },
];
const weekdays: { id: Weekday; label: string }[] = [
  { id: 1, label: '月' }, { id: 2, label: '火' }, { id: 3, label: '水' }, { id: 4, label: '木' },
  { id: 5, label: '金' }, { id: 6, label: '土' }, { id: 7, label: '日' },
];
const notificationGateway = new ExpoLocalNotificationGateway();

export default function SettingsScreen() {
  const { snapshot, error: loadError, refresh, database } = usePlannerData({ personal: true });
  const workspace = useContext(WorkspaceContext);
  if (!snapshot) return <PlannerLoadState title="設定" message="設定を読み込んでいます。" error={loadError} retry={refresh} onBack={() => router.back()} />;
  if (workspace?.userId) return <AccountSettings key={workspace.userId} userId={workspace.userId} snapshot={snapshot} loadError={loadError} refresh={refresh} database={database} />;
  return <SettingsContent snapshot={snapshot} loadError={loadError} refresh={refresh} database={database} />;
}

function AccountSettings(props: { userId: string; snapshot: PlannerSnapshot; loadError: string | null; refresh: () => Promise<void>; database: SQLiteDatabase }) {
  const initial = useRef(props.snapshot); const { database, userId } = props; const focused = useRef(false);
  const [source, setSource] = useState<{ value: ReturnType<typeof createOwnerRhythmSettings>; attempt: number } | null>(null);
  const [error, setError] = useState<string | null>(null); const [attempt, setAttempt] = useState(0);
  const unsettled = useRef(false); const onDraftChange = useCallback((value: boolean) => { unsettled.current = value; }, []);
  useLayoutEffect(() => { initial.current = props.snapshot; }, [props.snapshot]);
  useFocusEffect(useCallback(() => { if (focused.current && !unsettled.current) setAttempt(value => value + 1); else focused.current = true; }, []));
  useEffect(() => { let current = true;
    void (async () => {
      const user = await sharingSessionUser();
      if (!current) return;
      if (user?.uid !== userId) throw new Error('設定を開くアカウントが変わりました。');
      const { nativePrivatePlannerPreferences } = await import('@/platform/sharing/private-calendar-secrets');
      const store = nativePrivatePlannerPreferences(userId); const saved = await store.read();
      const value = createOwnerRhythmSettings({ store, saved, local: initial.current.settings, timeZone: getDeviceTimeZone(),
        saveLocal: (next, expected) => updatePlannerSettings(database, next, expected) });
      if (current) { setSource({ value, attempt }); setError(null); }
    })().catch(() => { if (current) setError('本人の生活リズムを読み込めませんでした。保存済みの内容は保持しています。'); });
    return () => { current = false; };
  }, [database, userId, attempt]);
  if (!source || source.attempt !== attempt) return <PlannerLoadState title="設定" message="設定を読み込んでいます。" error={error} retry={async () => setAttempt(value => value + 1)} onBack={() => router.back()} />;
  return <SettingsContent key={attempt} {...props} snapshot={{ ...props.snapshot, settings: { ...props.snapshot.settings, ...source.value.settings() } }} saveRhythm={source.value.save}
    onDraftChange={onDraftChange} reloadRhythm={() => setAttempt(value => value + 1)} />;
}

function SettingsContent({ snapshot, loadError, refresh, database, saveRhythm, reloadRhythm, onDraftChange }: {
  snapshot: PlannerSnapshot;
  loadError: string | null;
  refresh: (options?: { waitForWeather?: boolean }) => Promise<void>;
  database: SQLiteDatabase;
  saveRhythm?: (value: PlannerRhythm) => Promise<void>;
  reloadRhythm?: () => void;
  onDraftChange?: (unsettled: boolean) => void;
}) {
  const workspace = useContext(WorkspaceContext);
  const v2 = workspace?.active?.protocol === 2;
  const [mode, setMode] = useState<FrequencyMode>(snapshot.settings.frequencyMode);
  const [restDays, setRestDays] = useState<Weekday[]>(snapshot.settings.restDays as Weekday[]);
  const [heavyLimit, setHeavyLimit] = useState(snapshot.settings.heavyDailyLimit);
  const [normalLimit, setNormalLimit] = useState(snapshot.settings.normalDailyLimit);
  const plannerDraftBase = useRef({ frequencyMode: snapshot.settings.frequencyMode, restDays: snapshot.settings.restDays,
    heavyDailyLimit: snapshot.settings.heavyDailyLimit, normalDailyLimit: snapshot.settings.normalDailyLimit });
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [weatherUpdating, setWeatherUpdating] = useState(false);
  const [weatherRegion, setWeatherRegion] = useState(snapshot.settings.weatherLocation?.region ?? '');
  const [weatherSearchEnabled, setWeatherSearchEnabled] = useState(false);
  const [weatherCandidate, setWeatherCandidate] = useState<WeatherRegionCandidate | null>(null);
  const [weatherResultsDismissed, setWeatherResultsDismissed] = useState(false);
  const [weatherMessage, setWeatherMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const [notificationUpdating, setNotificationUpdating] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const [googleSyncState, setGoogleSyncState] = useState<GoogleSyncState | null>(null);
  const [googleConnected, setGoogleConnected] = useState(false);
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

  const refreshGoogleState = useCallback(async () => {
    const [state, connected, calendarState] = await Promise.all([
      loadGoogleSyncState(database, LOCAL_HOUSEHOLD_ID),
      hasGoogleTasksSession(),
      loadCalendarAvailabilityState(database),
    ]);
    setGoogleSyncState(state);
    setGoogleConnected(connected && Boolean(state) && !state?.disconnected);
    setCalendarAvailabilityState(calendarState);
  }, [database]);

  useEffect(() => {
    // SQLite state is external persisted state; hydrate the screen after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshGoogleState().catch(() => {
      setGoogleMessage({ text: 'Google同期の設定を読み込めませんでした。', kind: 'error' });
    });
  }, [refreshGoogleState]);

  const connectGoogle = async () => {
    if (googleBusy) return;
    if (!beginOperation('google')) return;
    setGoogleBusy(true);
    setGoogleMessage(null);
    try {
      await authorizeGoogleTasks();
      const current = await loadGoogleSyncState(database, LOCAL_HOUSEHOLD_ID);
      const now = new Date().toISOString();
      await saveGoogleSyncState(database, {
        householdId: LOCAL_HOUSEHOLD_ID,
        enabled: true,
        taskListId: current?.taskListId,
        lastAttemptAt: current?.lastAttemptAt,
        lastSuccessfulSyncAt: current?.lastSuccessfulSyncAt,
        status: 'idle',
        retryCount: 0,
        updatedAt: now,
      });
      setGoogleConnected(true);
      await refreshGoogleState();
      try { await registerGoogleSyncBackgroundTask(); } catch { /* Foreground sync remains available. */ }
      const result = await syncGoogleTasks(database, { force: true });
      await refreshGoogleState();
      setGoogleMessage(result.kind === 'success'
        ? result.skipped
          ? { text: 'Googleには接続しましたが、同期は実行されていません。同期設定を確認してください。', kind: 'error' }
          : { text: 'Google Tasksに接続し、同期しました。', kind: 'success' }
        : { text: syncFailureMessage(result.kind, result.code), kind: 'error' });
    } catch (cause) {
      setGoogleMessage({ text: cause instanceof Error && cause.name === 'GoogleAuthorizationCancelledError'
        ? 'Googleとの接続をキャンセルしました。'
        : 'Google Tasksに接続できませんでした。OAuth設定と端末の開発ビルドを確認してください。', kind: 'error' });
      await refreshGoogleState().catch(() => undefined);
    } finally {
      endOperation('google'); setGoogleBusy(false);
    }
  };

  const toggleGoogleSync = async (enabled: boolean) => {
    if (googleBusy) return;
    if (!beginOperation('google')) return;
    setGoogleBusy(true);
    setGoogleMessage(null);
    try {
      const current = await loadGoogleSyncState(database, LOCAL_HOUSEHOLD_ID);
      const now = new Date().toISOString();
      const previous: GoogleSyncState = current ?? {
        householdId: LOCAL_HOUSEHOLD_ID,
        enabled: false,
        status: 'idle',
        retryCount: 0,
        updatedAt: now,
      };
      if (enabled) {
        if (previous.status === 'authRequired' || !await hasGoogleTasksSession()) await authorizeGoogleTasks();
        else await getGoogleTasksAccessToken();
      }
      await saveGoogleSyncState(database, {
        ...previous,
        enabled,
        status: 'idle',
        retryCount: enabled ? previous.retryCount : 0,
        nextRetryAt: undefined,
        lastErrorCode: undefined,
        lastErrorAt: undefined,
        updatedAt: now,
      });
      setGoogleSyncState({ ...previous, enabled, status: 'idle', retryCount: enabled ? previous.retryCount : 0, nextRetryAt: undefined, lastErrorCode: undefined, lastErrorAt: undefined, updatedAt: now });
      if (enabled) {
        try { await registerGoogleSyncBackgroundTask(); } catch { /* Foreground sync remains available. */ }
        const result = await syncGoogleTasks(database, { force: true });
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
      if (googleSyncState.status === 'authRequired' || !await hasGoogleTasksSession()) await authorizeGoogleTasks();
      const result = await syncGoogleTasks(database, { force: true });
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
    if (googleBusy) return;
    if (!beginOperation('google')) return;
    setGoogleBusy(true);
    setGoogleMessage(null);
    try {
      await configureGoogleCalendarAvailability(database, false, authorizeGoogleCalendarAvailability);
      const current = await loadGoogleSyncState(database, LOCAL_HOUSEHOLD_ID);
      if (current) {
        await saveGoogleSyncState(database, {
          ...current,
          enabled: false,
          disconnected: true,
          status: 'idle',
          retryCount: 0,
          nextRetryAt: undefined,
          lastErrorCode: undefined,
          lastErrorAt: undefined,
          updatedAt: new Date().toISOString(),
        });
      }
      await unregisterGoogleSyncBackgroundTask().catch(() => undefined);
      if (!await hasOtherGoogleWorkspaceConnections(database)) await disconnectGoogleTasksSession();
      await refreshGoogleState();
      setGoogleMessage({ text: 'Googleとの接続を解除しました。Google Tasks上の家事は残しています。', kind: 'success' });
    } catch {
      await refreshGoogleState().catch(() => undefined);
      setGoogleMessage({ text: '端末内の同期設定は停止しましたが、Googleのアクセス許可を解除できませんでした。', kind: 'error' });
    } finally {
      endOperation('google'); setGoogleBusy(false);
    }
  };

  const toggleRestDay = (day: Weekday) => {
    const current = currentDraft.current.restDays;
    changeSettings({ restDays: current.includes(day) ? current.filter(value => value !== day) : [...current, day].sort() as Weekday[] });
  };

  const toggleSection = (section: string) => {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
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
  useLayoutEffect(() => { onDraftChange?.(!['idle', 'saved'].includes(autosave.status.phase)); }, [onDraftChange, autosave.status.phase]);
  const changeSettings = (patch: Partial<Rhythm>) => {
    currentDraft.current = { ...currentDraft.current, ...patch };
    const value = currentDraft.current;
    setMode(value.frequencyMode); setRestDays(value.restDays as Weekday[]); setHeavyLimit(value.heavyDailyLimit); setNormalLimit(value.normalDailyLimit);
    autosave.enqueue(patch);
  };

  const selectWeatherRegion = async (candidate: WeatherRegionCandidate) => {
    if (weatherUpdating) return;
    if (!beginOperation('weather')) return;
    setWeatherCandidate(candidate);
    setWeatherUpdating(true);
    setWeatherMessage(null);
    try {
      await saveWeatherLocation(database, {
        region: weatherRegion.trim(),
        displayName: candidate.label,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
      });
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

  const toggleNotifications = async (enabled: boolean) => {
    if (!beginOperation('notifications')) return;
    setNotificationUpdating(true);
    setNotificationMessage(null);
    try {
      if (enabled && !(await notificationGateway.requestPermission())) {
        setNotificationMessage({ text: '通知は有効になりませんでした。端末の設定から許可できます。', kind: 'error' });
        return;
      }
      await setNotificationsEnabled(database, enabled);
      await refresh();
      setNotificationMessage({ text: enabled ? '通知を有効にしました。' : '通知をオフにしました。', kind: 'success' });
    } catch {
      setNotificationMessage({ text: '通知設定を変更できませんでした。', kind: 'error' });
    } finally {
      endOperation('notifications'); setNotificationUpdating(false);
    }
  };

  return (
    <Page header={<BackButton onPress={() => void autosave.navigate(() => router.back())} />}>

      <ScreenHeading title="設定" />
      {autosave.status.phase === 'error' ? <Card><Text accessibilityRole="alert" style={styles.error}>{autosave.status.error}</Text><AppButton title="保存を再試行" variant="quiet" compact onPress={() => void autosave.flush()} />
        {reloadRhythm ? <AppButton title="未保存の入力を破棄して設定を読み直す" variant="quiet" compact onPress={() => {
          for (const key of Object.keys(currentDraft.current) as (keyof typeof currentDraft.current)[]) autosave.remove(key);
          reloadRhythm();
        }} /> : null}</Card> : autosave.status.phase === 'saving' || autosave.status.phase === 'pending' ? <Text style={styles.hint}>自動保存中…</Text> : null}
      {loadError ? <Card><Text style={styles.error}>{loadError}</Text></Card> : null}
      <AccordionSection title="家事ごとの設定" expanded={expandedSections.has('chore-settings')} onToggle={() => toggleSection('chore-settings')}>
        <ChoreSettingsSources first="personal" />
      </AccordionSection>

      <AccordionSection title="生活リズム" expanded={expandedSections.has('life-rhythm')} onToggle={() => toggleSection('life-rhythm')}>
        <Text style={styles.label}>家事の頻度</Text>
        <View style={styles.modeRow}>
          {modeOptions.map((option) => (
            <ChoiceChip key={option.id} label={`${option.label} · ${option.detail}`} selected={mode === option.id} onPress={() => changeSettings({ frequencyMode: option.id })} />
          ))}
        </View>
        <Text style={styles.label}>休日</Text>
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
                style={({ pressed }) => [styles.weekdayChip, selected && styles.weekdayChipSelected, pressed && styles.weekdayChipPressed]}
              >
                <Text style={[styles.weekdayChipText, selected && styles.weekdayChipTextSelected]}>{day.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>休日を含む期間になるよう、家事ごとの許容範囲内で予定を調整します。</Text>
        <View style={styles.limitRow}>
          <View style={styles.limitCopy}><Text style={styles.label}>重い家事の1日上限</Text><Text style={styles.hint}>初期値：1件</Text></View>
          <Counter value={heavyLimit} onChange={heavyDailyLimit => changeSettings({ heavyDailyLimit })} maximum={10} label="重い家事の上限" />
        </View>
        <View style={styles.limitRow}>
          <View style={styles.limitCopy}><Text style={styles.label}>普通の家事の1日上限</Text><Text style={styles.hint}>初期値：2件</Text></View>
          <Counter value={normalLimit} onChange={normalDailyLimit => changeSettings({ normalDailyLimit })} maximum={20} label="普通の家事の上限" />
        </View>

      </AccordionSection>

      <AccordionSection title="通知・ウィジェット" expanded={expandedSections.has('notifications')} onToggle={() => toggleSection('notifications')}>
        <View style={styles.notificationRow}>
          <View style={styles.limitCopy}>
            <Text style={styles.featureTitle}>家事の通知を受け取る</Text>
            <Text style={styles.hint}>{snapshot.sharing ? `所属グループの家事を、${snapshot.timeZone}の毎朝9時に通知します。` : '毎朝9時に、期間の開始日・最終日・終了翌日に未完了の家事をまとめて通知します。'}</Text>
          </View>
          <Switch accessibilityLabel="家事の通知を受け取る" value={snapshot.settings.notificationsEnabled} disabled={notificationUpdating} onValueChange={(value) => void toggleNotifications(value)} />
        </View>
        {notificationMessage ? <Text accessibilityLiveRegion="polite" style={notificationMessage.kind === 'success' ? styles.success : styles.error}>{notificationMessage.text}</Text> : null}
        <View style={styles.divider} />
        {v2 ? <GroupManagementLinks section="notifications" busy={notificationUpdating} onSelect={target => router.push(target)} /> : null}
        <FeatureStatus title="今日の家事ウィジェット" status="iOS・Android" detail={snapshot.sharing ? "Widgetは個人モードの家事を表示します。共有グループの家事はアプリで確認できます。" : "最大3件を表示します。丸を押すと完了でき、完了した家事はチェック付きで残ります。"} />
      </AccordionSection>

      <Card style={{ paddingVertical: 4 }}><Pressable accessibilityRole="button" accessibilityLabel="ゴミ収集日を管理" onPress={() => void autosave.navigate(() => router.push(v2 ? '/group-v2/waste' : '/waste'))} style={[styles.notificationRow, { minHeight: 46 }]}>
        <Text style={[typography.section, { color: palette.ink, fontWeight: '700', flex: 1 }]}>{v2 ? 'グループのゴミ収集日' : 'ゴミ収集日'}</Text><Chevron />
      </Pressable></Card>

      {!snapshot.sharing ? <AccordionSection title="天気予報・洗濯" expanded={expandedSections.has('weather')} onToggle={() => toggleSection('weather')}>
        <Text style={styles.hint}>{snapshot.settings.weatherLocation
          ? `対象地域：${snapshot.settings.weatherLocation.displayName}。予報取得時に、この地域の座標をOpen-Meteoへ送信します。`
          : '市区町村を選ぶと、天気に合わせて洗濯予定を調整します。端末の位置情報は使いません。'}</Text>
        <TextInput
          value={weatherRegion}
          editable={!weatherUpdating}
          onChangeText={(value) => {
            setWeatherRegion(value);
            setWeatherSearchEnabled(true);
            setWeatherResultsDismissed(false);
            setWeatherCandidate(null);
            setWeatherMessage(null);
          }}
          placeholder="市区町村名を入力（例：横浜市）"
          placeholderTextColor={palette.muted}
          style={styles.regionInput}
          accessibilityLabel="天気予報に使う市区町村"
          returnKeyType="done"
        />
        <Text style={styles.hint}>入力すると候補を検索します。候補は「市区町村、都道府県」で表示します。</Text>
        {weatherSuggestions.status === 'searching' ? <ActivityIndicator color={palette.accent} /> : null}
        <View style={styles.weatherActions}>
          {snapshot.settings.weatherLocation ? (
            <AppButton title="連動を解除" onPress={() => void disableWeather()} disabled={weatherUpdating} variant="quiet" compact />
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
        {weatherSuggestions.status === 'error' && !weatherResultsDismissed
          ? <Text style={styles.error}>{weatherSuggestions.error}</Text>
          : null}
        {weatherSuggestions.status === 'debouncing' || weatherSuggestions.status === 'searching'
          ? <Text style={styles.hint}>市区町村を検索しています…</Text>
          : null}
        {weatherMessage ? (
          <Text style={weatherMessage.kind === 'success' ? styles.success : styles.error}>{weatherMessage.text}</Text>
        ) : null}
      </AccordionSection> : null}

      <AccordionSection title="誕生日" expanded={expandedSections.has('birthdays')} onToggle={() => toggleSection('birthdays')}>
        {expandedSections.has('birthdays') ? <BirthdaySettings /> : null}
      </AccordionSection>
      <AccordionSection title="Google連携" expanded={expandedSections.has('google-sync')} onToggle={() => toggleSection('google-sync')}>
        <FeatureStatus
          title="Google Tasks"
          status={googleConnected ? '接続済み' : googleSyncState?.enabled ? '再認証が必要' : googleOAuthConfigured ? '未接続' : 'OAuth設定待ち'}
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
              <Switch accessibilityLabel="Google Tasksの自動同期" value={Boolean(googleSyncState?.enabled)} disabled={googleBusy} onValueChange={(value) => void toggleGoogleSync(value)} />
            </View>
            <FeatureStatus
              title="同期状態"
              status={googleSyncState?.enabled ? googleSyncStatusLabel(googleSyncState.status) : '一時停止'}
              detail={`最終成功同期：${formatSyncTimestamp(googleSyncState?.lastSuccessfulSyncAt)}。iOS・Androidのバックグラウンド実行はOSの判断で遅れることがあります。`}
            />
            {!snapshot.sharing ? <>
            <View style={styles.notificationRow}>
              <View style={styles.limitCopy}>
                <Text style={styles.featureTitle}>Googleカレンダーの予定を家事日調整に使う</Text>
                <Text style={styles.hint}>予定のタイトルや内容は取得せず、予定が入っている時間帯だけを使って家事日を調整します。</Text>
                <Text style={styles.hint}>現在はGoogleアカウントのメインカレンダーを対象にします。</Text>
              </View>
              <Switch accessibilityLabel="Googleカレンダーの予定を家事日調整に使う"
                value={Boolean(calendarAvailabilityState?.enabled)} disabled={googleBusy || !googleSyncState?.enabled}
                onValueChange={(value) => void toggleCalendarAvailability(value)} />
            </View>
            <FeatureStatus title="カレンダー連携"
              status={calendarAvailabilityState?.status === 'permissionRequired' ? '追加の許可が必要'
                : !calendarAvailabilityState?.enabled ? '無効'
                  : calendarAvailabilityState.status === 'retryPending' ? '取得失敗・再試行待ち'
                    : calendarAvailabilityState.status === 'syncing' ? '取得中'
                      : calendarAvailabilityState.status === 'error' ? '取得エラー' : '有効'}
              detail={`最終取得：${formatSyncTimestamp(calendarAvailabilityState?.lastSuccessfulSyncAt)}。36時間を超えた情報は使いません。`} />
            {calendarAvailabilityState?.status === 'permissionRequired' ? (
              <AppButton title="カレンダーの許可を確認" onPress={() => void toggleCalendarAvailability(true)} disabled={googleBusy || !googleSyncState?.enabled} />
            ) : null}
            {calendarAvailabilityState?.lastErrorCode === 'calendar_api_not_enabled' ? (
              <Text style={styles.error}>Google Calendar APIが無効です。Google Cloudのプロジェクト設定で有効にしてください。</Text>
            ) : null}
            {calendarAvailabilityMessage ? <Text style={styles.hint}>{calendarAvailabilityMessage}</Text> : null}
            </> : null}
            <View style={styles.googleActions}>
              <AppButton title={googleBusy ? '同期中…' : googleSyncState?.status === 'authRequired' ? '再接続して同期' : '今すぐ同期'} onPress={() => void syncGoogleNow()} disabled={googleBusy || !googleSyncState?.enabled} />
              <AppButton title="接続解除" onPress={() => void disconnectGoogle()} disabled={googleBusy} variant="danger" />
            </View>
          </>
        ) : (
          <AppButton title={googleBusy ? '接続中…' : 'Googleと接続'} onPress={() => void connectGoogle()} disabled={googleBusy || !googleOAuthConfigured} />
        )}
        <Text style={styles.hint}>同期する家事名と予定日をGoogleへ送信します。接続解除時もGoogle Tasks上の既存家事は削除しません。Google Tasks権限は広い範囲に適用されるため、信頼できるGoogleアカウントで接続してください。</Text>
        {v2 ? <GroupManagementLinks section="google" busy={googleBusy} onSelect={target => router.push(target)} /> : null}
        {googleMessage ? <Text style={googleMessage.kind === 'success' ? styles.success : styles.error}>{googleMessage.text}</Text> : null}
      </AccordionSection>

      <Card style={{ paddingVertical: 4 }}><Pressable accessibilityRole="button" accessibilityLabel="共有グループを管理" onPress={() => void autosave.navigate(() => router.push(
        workspace?.group && workspace.group.userId === workspace.userId && ['active', 'creating', 'joining'].includes(workspace.group.status)
          ? { pathname: '/sharing/group/[groupId]', params: { groupId: workspace.group.groupId } } : '/sharing'))} style={[styles.notificationRow, { minHeight: 46 }]}>
        <Text style={[typography.section, { color: palette.ink, fontWeight: '700', flex: 1 }]}>共有グループ</Text><Chevron />
      </Pressable></Card>
      {workspace?.userId ? <AccordionSection title="アカウントと端末" expanded={expandedSections.has('account-devices')} onToggle={() => toggleSection('account-devices')}>
        <Pressable accessibilityRole="button" accessibilityLabel="設定の端末間同期" onPress={() => void autosave.navigate(() => router.push('/sharing/personal-preferences'))} style={[styles.notificationRow, { minHeight: 44 }]}><Text style={[styles.label, { flex: 1 }]}>設定の端末間同期</Text><Chevron /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="同期する端末の管理" onPress={() => void autosave.navigate(() => router.push('/sharing/private-calendar'))} style={[styles.notificationRow, { minHeight: 44 }]}><Text style={[styles.label, { flex: 1 }]}>同期する端末の管理</Text><Chevron /></Pressable>
      </AccordionSection> : null}

      <AccordionSection title="バックグラウンド同期の実行記録" expanded={expandedSections.has('backgroundDiagnostics')} onToggle={() => toggleSection('backgroundDiagnostics')}>
        {expandedSections.has('backgroundDiagnostics') ? <BackgroundSyncDiagnostics /> : null}
      </AccordionSection>
      {typeof __DEV__ !== 'undefined' && __DEV__ ? <AppButton title="開発検査" onPress={() => router.push('/development')} variant="quiet" /> : null}
      <DataCredits />
      <Text style={styles.footer}>{snapshot.sharing ? '共有グループの家事と履歴は端末に保存し、暗号化して共有先へ同期します。' : '家事データ、曜日、予定、履歴はローカルSQLiteに保存されます。'}</Text>
    </Page>
  );
}

function Counter({ value, onChange, maximum, label }: {
  value: number; onChange: (value: number) => void; maximum: number; label: string;
}) {
  return (
    <View style={styles.counter}>
      <Pressable onPress={() => onChange(Math.max(1, value - 1))} disabled={value <= 1}
        accessibilityRole="button" accessibilityLabel={`${label}を減らす`}>
        <Text style={[styles.counterButton, value <= 1 && { opacity: 0.35 }]}>−</Text>
      </Pressable>
      <Text style={styles.counterValue}>{value}</Text>
      <Pressable onPress={() => onChange(Math.min(maximum, value + 1))} disabled={value >= maximum}
        accessibilityRole="button" accessibilityLabel={`${label}を増やす`}>
        <Text style={[styles.counterButton, value >= maximum && { opacity: 0.35 }]}>＋</Text>
      </Pressable>
    </View>
  );
}

function FeatureStatus({ title, status, detail }: { title: string; status: string; detail: string }) {
  return (
    <View style={styles.feature}>
      <View style={styles.featureTop}><Text style={styles.featureTitle}>{title}</Text><Text style={styles.featureStatus}>{status}</Text></View>
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
  if (kind === 'retry') return '一時的な通信エラーです。約1時間後に再試行します。';
  if (kind === 'authRequired') return 'Googleへの再認証が必要です。Googleと再接続してください。';
  return '同期できませんでした。同期状態を確認し、OAuth設定を見直してください。';
}



const styles = StyleSheet.create({
  accordionChevron: { color: palette.accent, fontSize: 23, fontWeight: '700', lineHeight: 28, transform: [{ rotate: '0deg' }] },
  accordionChevronExpanded: { transform: [{ rotate: '180deg' }] },
  label: { ...typography.label, color: palette.ink, fontWeight: '700' },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
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
  featureStatus: { ...typography.caption, color: palette.accent, fontWeight: '700', backgroundColor: palette.accentSoft, borderRadius: 8, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 4 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: palette.border, marginVertical: 1 },
  footer: { ...typography.caption, color: palette.muted, textAlign: 'center' },
  error: { ...typography.label, color: palette.warning },
  success: { ...typography.label, color: palette.accent, fontWeight: '600' },
});
