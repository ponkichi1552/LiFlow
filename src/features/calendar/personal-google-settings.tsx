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

type Conflict = Awaited<ReturnType<PersonalGoogleCalendarSync['readConflicts']>>[number];
export function PersonalGoogleCalendarSettings({ database, embedded = false }: { database: SQLiteDatabase; embedded?: boolean }) {
  const accountOperation = useAccountOperation();
  const [connection, setConnection] = useState<{ database: SQLiteDatabase; value: PersonalGoogleCalendarSync } | null>(null);
  const runtime = connection?.database === database ? connection.value : null;
  const [control, setControl] = useState<PersonalGoogleCalendarControl | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const refreshId = useRef(0);
  const [displayedDatabase, setDisplayedDatabase] = useState(database);
  if (displayedDatabase !== database) {
    setDisplayedDatabase(database); setBusy(false); setControl(null); setConflicts([]); setConnection(null); setError(null);
  }
  const scope = useRef({ database, active: true });
  useLayoutEffect(() => {
    const current = { database, active: true }; scope.current = current;
    refreshId.current++; lock.current = false;
    return () => { current.active = false; };
  }, [database]);
  const refresh = async (value: PersonalGoogleCalendarSync, current = scope.current) => {
    if (!current.active || current !== scope.current) return;
    const id = ++refreshId.current;
    const [next, rows] = await Promise.all([value.readControl(), value.readConflicts()]);
    if (current.active && current === scope.current && refreshId.current === id) { setControl(next); setConflicts(rows); }
  };
  useEffect(() => {
    const current = scope.current; let active = true;
    const isCurrent = () => active && current.active && current === scope.current;
    void import('../../platform/google-calendar/personal-runtime').then(async ({ nativePersonalGoogleCalendar }) => {
      if (!isCurrent()) return;
      const value = nativePersonalGoogleCalendar(database); setConnection({ database, value }); await refresh(value, current);
    }).catch(() => { if (isCurrent()) setError('Googleの接続設定を読み込めません。'); });
    return () => { active = false; };
  }, [database]);
  useEffect(() => {
    if (!runtime) return;
    const current = scope.current;
    return subscribeLocalCalendar(database, change => {
      if (change === 'sync' || change === 'syncStatus') void refresh(runtime, current).catch(() => { /* Keep the last saved status on a transient read failure. */ });
    });
  }, [database, runtime]);
  const run = async (work: (value: PersonalGoogleCalendarSync, isCurrent: () => boolean) => Promise<void>) => {
    const current = scope.current;
    const isCurrent = () => current.active && current.database === database && current === scope.current;
    if (lock.current || !runtime || !isCurrent() || accountOperation && !accountOperation.acquire()) return; lock.current = true; setBusy(true); setError(null);
    try { await work(runtime, isCurrent); await refresh(runtime, current); }
    catch (cause) { if (isCurrent()) setError(cause instanceof Error && cause.name === 'CalendarPermissionRequiredError'
      ? 'Googleカレンダーへのアクセスを許可してから、もう一度接続してください。'
      : cause instanceof Error ? cause.message : 'Googleの接続を確認してください。'); }
    finally { accountOperation?.release(); if (isCurrent()) { lock.current = false; setBusy(false); } }
  };
  const backgroundSync = (value: PersonalGoogleCalendarSync) => {
    const current = scope.current;
    void value.sync({ force: true }).then(() => refresh(value, current)).catch(() => { if (current.active && current === scope.current) setError('変更は保存済みです。次の同期で再試行します。'); });
  };
  const destination = control?.calendars.find(calendar => calendar.id === control.targetCalendarId);
  const disabled = busy || accountOperation?.busy === true;
  return <View style={[{ gap: 10 }, !embedded && { borderTopWidth: 1, borderTopColor: palette.border, paddingTop: 14 }]}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ ...typography.label, color: palette.ink, flex: 1 }}>{embedded ? '個人予定を同期' : 'Googleカレンダーと同期'}</Text>
      <SettingsCheckbox accessibilityLabel="Googleカレンダーと個人予定を双方向同期" value={control?.enabled === true} disabled={disabled || !runtime || !control}
        onValueChange={enabled => void run(async (value, isCurrent) => {
          if (!enabled) { await value.disable(control!); return; }
          const prepared = await value.prepareConnection(); if (!isCurrent()) return;
          await value.connect(prepared); if (!isCurrent()) return;
          try { const { registerGoogleSyncBackgroundTask } = await import('../google-sync/background-task'); await registerGoogleSyncBackgroundTask(); } catch { /* Foreground/resume synchronization remains available. */ }
          if (isCurrent()) backgroundSync(value);
        })} />
    </View>
    <Text style={{ ...typography.caption, color: palette.muted }}>Googleの共有予定も、自分だけに表示。</Text>
    {control?.enabled ? <>
      {destination ? <Text style={{ ...typography.caption, color: palette.muted }}>新しい予定の保存先：{destination.summary}</Text> : null}
      <Text style={{ ...typography.caption, color: palette.muted }}>最終同期：{control.lastSyncAt ? new Date(control.lastSyncAt).toLocaleString('ja-JP') : 'まだ同期していません'}</Text>
      <SettingsAction placement={embedded ? 'panel' : 'page'} compact title={busy ? '同期中…' : '今すぐ同期'} disabled={disabled} onPress={() => void run(async value => { await value.sync({ interactive: true, force: true }); })} />
    </> : null}
    {error || control?.error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>{error ?? control?.error}</Text> : null}
    {conflicts.length ? <Text style={{ ...typography.label, color: palette.ink }}>同時に変更された予定</Text> : null}
    {conflicts.map(row => <View key={`${row.calendarId}:${row.googleId}`} style={{ gap: 8, borderWidth: 1, borderColor: palette.border, borderRadius: 12, padding: 12 }}>
      <Text style={{ ...typography.label, color: palette.ink }}>{row.local?.title ?? row.remote.summary ?? '削除した予定'}</Text>
      <Text style={{ ...typography.caption, color: palette.muted }}>LiFlow：{row.local ? `${row.local.startDate.replaceAll('-', '/')} ${row.local.title}` : '削除'}</Text>
      <Text style={{ ...typography.caption, color: palette.muted }}>Google：{row.remote.status === 'cancelled' ? '削除' : `${row.remote.start?.date ?? row.remote.start?.dateTime ?? ''} ${row.remote.summary ?? ''}`}</Text>
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
