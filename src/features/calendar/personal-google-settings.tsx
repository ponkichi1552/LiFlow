import { useEffect, useRef, useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Pressable, Text, View } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import { SettingsSwitch } from '../../components/settings-switch';
import type { PersonalGoogleCalendarSync } from './personal-google-sync';
import type { PersonalGoogleCalendarControl } from '../../platform/storage/personal-google-calendar';
import { subscribeLocalCalendar } from '../../platform/storage/calendar-events';

type Conflict = Awaited<ReturnType<PersonalGoogleCalendarSync['readConflicts']>>[number];
export function PersonalGoogleCalendarSettings({ database }: { database: SQLiteDatabase }) {
  const [runtime, setRuntime] = useState<PersonalGoogleCalendarSync | null>(null);
  const [control, setControl] = useState<PersonalGoogleCalendarControl | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [busy, setBusy] = useState(false); const lock = useRef(false); const alive = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const refreshId = useRef(0);
  const refresh = async (value: PersonalGoogleCalendarSync) => {
    const id = ++refreshId.current;
    const [next, rows] = await Promise.all([value.readControl(), value.readConflicts()]);
    if (alive.current && refreshId.current === id) { setControl(next); setConflicts(rows); }
  };
  useEffect(() => {
    alive.current = true;
    void import('../../platform/google-calendar/personal-runtime').then(async ({ nativePersonalGoogleCalendar }) => {
      const value = nativePersonalGoogleCalendar(database); if (alive.current) setRuntime(value); await refresh(value);
    }).catch(() => { if (alive.current) setError('Googleの接続設定を読み込めません。'); });
    return () => { alive.current = false; };
  }, [database]);
  useEffect(() => {
    if (!runtime) return;
    return subscribeLocalCalendar(database, change => {
      if (change === 'sync' || change === 'syncStatus') void refresh(runtime).catch(() => { /* Keep the last saved status on a transient read failure. */ });
    });
  }, [database, runtime]);
  const run = async (work: (value: PersonalGoogleCalendarSync) => Promise<void>) => {
    if (lock.current || !runtime) return; lock.current = true; setBusy(true); setError(null);
    try { await work(runtime); await refresh(runtime); }
    catch (cause) { if (alive.current) setError(cause instanceof Error && cause.name === 'CalendarPermissionRequiredError'
      ? 'Googleカレンダーへのアクセスを許可してから、もう一度接続してください。'
      : cause instanceof Error ? cause.message : 'Googleの接続を確認してください。'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const backgroundSync = (value: PersonalGoogleCalendarSync) => {
    void value.sync({ force: true }).then(() => refresh(value)).catch(() => { if (alive.current) setError('変更は保存済みです。次の同期で再試行します。'); });
  };
  const destination = control?.calendars.find(calendar => calendar.id === control.targetCalendarId);
  return <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: palette.border, paddingTop: 14 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ ...typography.label, color: palette.ink, flex: 1 }}>Googleカレンダーと同期</Text>
      <SettingsSwitch accessibilityLabel="Googleカレンダーと個人予定を双方向同期" value={control?.enabled === true} disabled={busy || !runtime || !control}
        onValueChange={enabled => void run(async value => {
          if (!enabled) { await value.disable(control!); return; }
          await value.connect(await value.prepareConnection());
          try { const { registerGoogleSyncBackgroundTask } = await import('../google-sync/background-task'); await registerGoogleSyncBackgroundTask(); } catch { /* Foreground/resume synchronization remains available. */ }
          backgroundSync(value);
        })} />
    </View>
    <Text style={{ ...typography.caption, color: palette.muted }}>個人予定を自動で同期します。Googleの共有カレンダーも本人だけに表示します。</Text>
    {control?.enabled ? <>
      {destination ? <Text style={{ ...typography.caption, color: palette.muted }}>新しい予定の保存先：{destination.summary}</Text> : null}
      <Text style={{ ...typography.caption, color: palette.muted }}>最終同期：{control.lastSyncAt ? new Date(control.lastSyncAt).toLocaleString('ja-JP') : 'まだ同期していません'}</Text>
      <AppButton compact variant="quiet" title={busy ? '同期中…' : '今すぐ同期'} disabled={busy} onPress={() => void run(async value => { await value.sync({ interactive: true, force: true }); })} />
    </> : null}
    {error || control?.error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>{error ?? control?.error}</Text> : null}
    {conflicts.length ? <Text style={{ ...typography.label, color: palette.ink }}>同時に変更された予定</Text> : null}
    {conflicts.map(row => <View key={`${row.calendarId}:${row.googleId}`} style={{ gap: 8, borderWidth: 1, borderColor: palette.border, borderRadius: 12, padding: 12 }}>
      <Text style={{ ...typography.label, color: palette.ink }}>{row.local?.title ?? row.remote.summary ?? '削除した予定'}</Text>
      <Text style={{ ...typography.caption, color: palette.muted }}>LiFlow：{row.local ? `${row.local.startDate.replaceAll('-', '/')} ${row.local.title}` : '削除'}</Text>
      <Text style={{ ...typography.caption, color: palette.muted }}>Google：{row.remote.status === 'cancelled' ? '削除' : `${row.remote.start?.date ?? row.remote.start?.dateTime ?? ''} ${row.remote.summary ?? ''}`}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {(['local', 'google'] as const).filter(choice => choice !== 'local' || row.canKeepLocal).map(choice => <Pressable key={choice} accessibilityRole="button" disabled={busy}
          accessibilityLabel={`${row.local?.title ?? row.remote.summary ?? '予定'}に${choice === 'local' ? 'LiFlow' : 'Google'}の変更を採用`}
          onPress={() => void run(async value => { await value.resolveConflict(row, choice); backgroundSync(value); })} style={{ minHeight: 44, justifyContent: 'center' }}>
          <Text style={{ ...typography.label, color: palette.accent }}>{choice === 'local' ? 'LiFlowを採用' : 'Googleを採用'}</Text>
        </Pressable>)}
      </View>
    </View>)}
  </View>;
}
