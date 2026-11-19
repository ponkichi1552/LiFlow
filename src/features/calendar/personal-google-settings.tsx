import { SettingsAction } from '../../components/settings-controls';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Pressable, Text, View } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { SettingsCheckbox } from '../../components/settings-checkbox';
import type { PersonalGoogleCalendarSync } from './personal-google-sync';
import type { PersonalGoogleCalendarControl } from '../../platform/storage/personal-google-calendar';
import { subscribeLocalCalendar } from '../../platform/storage/calendar-events';
import { useAccountOperation } from '../settings/account-operation';
import { isGoogleAuthenticationError } from '../google-sync/auth-error';
import { subscribeToGoogleAccountChanges } from '../google-sync/account-change-events';
import { useGoogleConnection } from '../settings/google-connection';
import { formatJapaneseDate } from '../../domain/scheduling/local-date';
import { googleImportedEvent } from './google-event-import';
import { minuteLabel, recurrenceLabel, type EventDraft } from './events';

type Conflict = Awaited<ReturnType<PersonalGoogleCalendarSync['readConflicts']>>[number];
export function PersonalGoogleCalendarSettings({ database, embedded = false }: { database: SQLiteDatabase; embedded?: boolean }) {
  const accountOperation = useAccountOperation();
  const connectionSettings = useGoogleConnection();
  const [connection, setConnection] = useState<{ database: SQLiteDatabase; value: PersonalGoogleCalendarSync } | null>(null);
  const runtime = connection?.database === database ? connection.value : null;
  const [control, setControl] = useState<PersonalGoogleCalendarControl | null>(null);
  const [checkedConnection, setCheckedConnection] = useState<{ subject: string; generation: number; ready: boolean } | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const refreshId = useRef(0);
  const [displayedDatabase, setDisplayedDatabase] = useState(database);
  if (displayedDatabase !== database) {
    setDisplayedDatabase(database); setBusy(false); setControl(null); setCheckedConnection(null); setNeedsReauth(false); setConflicts([]); setConnection(null); setError(null); setStatusError(null);
  }
  const scope = useRef({ database, active: true });
  useLayoutEffect(() => {
    const current = { database, active: true }; scope.current = current;
    refreshId.current++; lock.current = false;
    return () => { current.active = false; };
  }, [database]);
  const refresh = async (value: PersonalGoogleCalendarSync, current = scope.current, reportLoadError = false) => {
    if (!current.active || current !== scope.current) return;
    const id = ++refreshId.current;
    const isCurrent = () => current.active && current === scope.current && refreshId.current === id;
    try {
      const [next, rows] = await Promise.all([value.readControl(), value.readConflicts()]);
      if (!isCurrent()) return;
      setControl(next); setConflicts(rows);
      const ready = await value.isConnected(next);
      if (isCurrent()) { setCheckedConnection({ subject: next.subject, generation: next.generation, ready }); setStatusError(null); }
    } catch (cause) {
      if (!isCurrent()) return;
      if (reportLoadError) setStatusError('Googleの接続設定を読み込めません。');
      else throw cause;
    }
  };
  useEffect(() => {
    const current = scope.current; let active = true;
    const isCurrent = () => active && current.active && current === scope.current;
    void import('../../platform/google-calendar/personal-runtime').then(async ({ nativePersonalGoogleCalendar }) => {
      if (!isCurrent()) return;
      const value = nativePersonalGoogleCalendar(database); setConnection({ database, value }); await refresh(value, current, true);
    }).catch(() => { if (isCurrent()) setStatusError('Googleの接続設定を読み込めません。'); });
    return () => { active = false; };
  }, [database]);
  useEffect(() => {
    if (!runtime) return;
    const current = scope.current;
    return subscribeLocalCalendar(database, change => {
      if (change === 'sync' || change === 'syncStatus') void refresh(runtime, current).catch(() => { /* Keep the last saved status on a transient read failure. */ });
    });
  }, [database, runtime]);
  useEffect(() => {
    if (!runtime) return;
    const current = scope.current;
    return subscribeToGoogleAccountChanges(database, () => {
      if (!current.active || current !== scope.current) return;
      setCheckedConnection(null); setNeedsReauth(false); setError(null); setStatusError(null);
      void refresh(runtime, current).catch(() => { /* A failed status read must not restore the old authenticated action. */ });
    });
  }, [database, runtime]);
  const run = async (work: (value: PersonalGoogleCalendarSync, isCurrent: () => boolean) => Promise<void>) => {
    const current = scope.current;
    const isCurrent = () => current.active && current.database === database && current === scope.current;
    if (lock.current || !runtime || !isCurrent() || accountOperation && !accountOperation.acquire()) return; lock.current = true; setBusy(true); setError(null); setNeedsReauth(false);
    try { await work(runtime, isCurrent); await refresh(runtime, current); }
    catch (cause) { if (cause instanceof Error && cause.name === 'GoogleAuthorizationCancelledError') return;
      if (isCurrent()) { setNeedsReauth(isGoogleAuthenticationError(cause)); setError(cause instanceof Error && cause.name === 'CalendarPermissionRequiredError'
      ? 'Googleカレンダーへのアクセスを許可してから、もう一度接続してください。'
      : cause instanceof Error ? cause.message : 'Googleの接続を確認してください。'); } }
    finally { accountOperation?.release(); if (isCurrent()) { lock.current = false; setBusy(false); } }
  };
  const backgroundSync = (value: PersonalGoogleCalendarSync) => {
    const current = scope.current;
    void value.sync({ force: true }).then(() => refresh(value, current)).catch(() => { if (current.active && current === scope.current) setError('変更は保存済みです。次の同期で再試行します。'); });
  };
  const connectAndSync = async (value: PersonalGoogleCalendarSync, isCurrent: () => boolean) => {
    const prepared = await value.prepareConnection(); if (!isCurrent()) return;
    await value.connect(prepared); if (!isCurrent()) return;
    try { const { registerGoogleSyncBackgroundTask } = await import('../google-sync/background-task'); await registerGoogleSyncBackgroundTask(); } catch { /* Foreground/resume synchronization remains available. */ }
    if (isCurrent()) backgroundSync(value);
  };
  const destination = control?.calendars.find(calendar => calendar.id === control.targetCalendarId);
  const disabled = busy || accountOperation?.busy === true;
  const ready = needsReauth || control?.authRequired ? false : checkedConnection && checkedConnection.subject === control?.subject && checkedConnection.generation === control.generation ? checkedConnection.ready : null;
  const actionTitle = ready === null ? '接続を確認中…' : ready && control?.enabled ? '今すぐ同期' : !control?.enabled ? ready ? '同期を有効にする' : 'Googleと接続' : 'Googleに再接続';
  return <View style={[{ gap: 10 }, !embedded && { borderTopWidth: 1, borderTopColor: palette.border, paddingTop: 14 }]}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ ...typography.label, color: palette.ink, flex: 1 }}>{embedded ? '個人予定を同期' : 'Googleカレンダーと同期'}</Text>
      <SettingsCheckbox accessibilityLabel="Googleカレンダーと個人予定を双方向同期" value={control?.enabled === true} disabled={disabled || !runtime || !control || Boolean(connectionSettings && !connectionSettings.ready && !control.enabled)}
        onValueChange={enabled => void run(async (value, isCurrent) => {
          if (!enabled) { await value.disable(control!); return; }
          await connectAndSync(value, isCurrent);
        })} />
    </View>
    <Text style={{ ...typography.caption, color: palette.muted }}>Googleの共有予定も、自分だけに表示。</Text>
    {control?.enabled ? <>
      {destination ? <Text style={{ ...typography.caption, color: palette.muted }}>新しい予定の保存先：{destination.summary}</Text> : null}
      <Text style={{ ...typography.caption, color: palette.muted }}>最終同期：{control.lastSyncAt ? new Date(control.lastSyncAt).toLocaleString('ja-JP') : 'まだ同期していません'}</Text>
    </> : null}
    {error || statusError || control?.error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>{error ?? statusError ?? control?.error}</Text> : null}
    {!connectionSettings || control?.enabled ? <SettingsAction placement={embedded ? 'panel' : 'page'} compact title={busy ? ready && control?.enabled ? '同期中…' : '接続中…' : actionTitle} disabled={disabled || ready === null || !control}
      onPress={() => {
        if (connectionSettings && !ready) {
          const current = scope.current;
          void connectionSettings.reconnect().then(ok => {
            if (ok && current.active && current === scope.current) void run((value, isCurrent) => connectAndSync(value, isCurrent));
          }); return;
        }
        void run(async (value, isCurrent) => {
        if (ready && control?.enabled) { await value.sync({ interactive: true, force: true }); return; }
        if (control?.subject && ready === false) {
          const { changeGoogleAccount } = await import('../google-sync/account-switch');
          await changeGoogleAccount(database); if (!isCurrent()) return;
        }
        await connectAndSync(value, isCurrent);
      }); }} /> : null}
    {conflicts.length ? <Text style={{ ...typography.label, color: palette.ink }}>同時に変更された予定</Text> : null}
    {conflicts.map(row => <View key={`${row.calendarId}:${row.googleId}`} style={{ gap: 10, borderWidth: 1, borderColor: palette.border, borderRadius: 12, padding: 12 }}>
      <Text accessibilityRole="header" style={{ ...typography.label, color: palette.ink }}>{row.local?.title ?? row.remote.summary ?? '削除した予定'}</Text>
      <GoogleConflictComparison row={row} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {(['local', 'google'] as const).filter(choice => choice !== 'local' || row.canKeepLocal).map(choice => <Pressable key={choice} accessibilityRole="button" disabled={disabled}
          accessibilityLabel={`${row.local?.title ?? row.remote.summary ?? '予定'}に${choice === 'local' ? 'LiFlow' : 'Google'}の変更を採用`}
          onPress={() => void run(async (value, isCurrent) => { await value.resolveConflict(row, choice); if (isCurrent()) backgroundSync(value); })} style={{ minHeight: 44, justifyContent: 'center' }}>
          <Text style={{ ...typography.label, color: palette.accent }}>{choice === 'local' ? 'LiFlowを採用' : 'Googleを採用'}</Text>
        </Pressable>)}
      </View>
    </View>)}
  </View>;
}

function GoogleConflictComparison({ row }: { row: Conflict }) {
  const canceled = row.remote.status === 'cancelled';
  let google: EventDraft | undefined;
  if (!canceled) {
    try { google = googleImportedEvent(row.remote, row.local?.categoryId ?? 'personal', row.local?.timeZone); } catch { /* Keep the original Google values visible below. */ }
  }
  const local = row.local;
  const recurrence = (value: EventDraft) => recurrenceLabel(value) + (value.untilDate ? ` · ${formatJapaneseDate(value.untilDate, { year: true })}まで` : '');
  const clock = (value: EventDraft) => {
    const date = formatJapaneseDate(value.startDate, { year: true });
    if (value.allDay) return value.startDate === value.endDate ? `${date} · 終日` : `${date}〜${formatJapaneseDate(value.endDate, { year: true })} · 終日`;
    const end = value.endDate === value.startDate ? minuteLabel(value.endMinute) : `${formatJapaneseDate(value.endDate, { year: true })} ${minuteLabel(value.endMinute)}`;
    return `${date} ${minuteLabel(value.startMinute)}〜${end}（${value.timeZone}）`;
  };
  const showLocation = local?.location !== (google?.location ?? row.remote.location ?? '');
  const showNotes = local?.notes !== (google?.notes ?? row.remote.description ?? '');
  const showRepeat = !google || (local ? recurrence(local) !== recurrence(google) : google.recurrence !== 'none');
  const body = { ...typography.caption, color: palette.ink };
  return <>
    <View style={{ gap: 3 }}>
      <Text style={{ ...typography.label, color: palette.ink }}>LiFlow</Text>
      {local ? <>
        <Text style={body}>{local.title}</Text><Text style={body}>{clock(local)}</Text>
        {showLocation && <Text style={body}>場所　{local.location || 'なし'}</Text>}
        {showNotes && <Text style={body}>メモ　{local.notes || 'なし'}</Text>}
        {showRepeat && <Text style={body}>{recurrence(local)}</Text>}
      </> : <Text style={body}>削除</Text>}
    </View>
    <View style={{ gap: 3, borderTopWidth: 1, borderColor: palette.border, paddingTop: 8 }}>
      <Text style={{ ...typography.label, color: palette.ink }}>Google</Text>
      {canceled ? <Text style={body}>削除</Text> : <>
        <Text style={body}>{google?.title ?? row.remote.summary ?? '無題の予定'}</Text>
        <Text style={body}>{google ? clock(google) : [row.remote.start?.date ?? row.remote.start?.dateTime, row.remote.end?.date ?? row.remote.end?.dateTime].filter(Boolean).join('〜')}</Text>
        {showLocation && <Text style={body}>場所　{(google?.location ?? row.remote.location) || 'なし'}</Text>}
        {showNotes && <Text style={body}>メモ　{(google?.notes ?? row.remote.description) || 'なし'}</Text>}
        {showRepeat && <Text style={body}>{google ? recurrence(google) : row.remote.recurrence?.length ? 'Google上で繰り返しを確認してください。' : '繰り返さない'}</Text>}
      </>}
    </View>
  </>;
}
