import { useEffect, useRef, useState } from 'react';
import { Text, View, useColorScheme } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { SettingsCheckbox } from '../../components/settings-checkbox';
import { SettingsLabel } from '../../components/settings-controls';
import { typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { expoLocalNotificationGateway } from '../../platform/notifications/expo-local-notification-gateway';
import { setCalendarNotificationsEnabled } from '../../platform/storage/calendar-reminders';
import { useCalendarReminders } from './use-calendar-reminders';
import { NotificationPermissionRecovery } from '../notifications/notification-permission-recovery';
export function CalendarNotificationSettings({ database }: { database: SQLiteDatabase }) {
  const { settings, error: readError, loading } = useCalendarReminders(database); const colors = plannerColorsForScheme(useColorScheme());
  const [busy, setBusy] = useState(false); const pending = useRef(false); const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false); const current = useRef<SQLiteDatabase | null>(database);
  useEffect(() => { current.current = database; return () => { current.current = null; }; }, [database]);
  const save = async (enabled: boolean) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(null);
    try {
      if (enabled && !await expoLocalNotificationGateway.requestPermission()) { if (current.current === database) { setPermissionDenied(true); setError('端末の通知がオフです。'); } return; }
      if (current.current !== database) return;
      await setCalendarNotificationsEnabled(database, enabled);
      if (current.current === database) setPermissionDenied(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '通知設定を保存できませんでした。'); }
    finally { pending.current = false; setBusy(false); }
  };
  return <View style={{ gap: 8, borderTopWidth: 1, borderColor: colors.border, paddingTop: 16, marginTop: 16 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}><View style={{ flex: 1, gap: 4 }}><SettingsLabel>カレンダー通知</SettingsLabel><Text style={{ ...typography.caption, color: colors.muted }}>通知するタイミングは予定ごとに選択。</Text></View>
      <SettingsCheckbox accessibilityLabel="カレンダー通知を受け取る" value={settings.enabled} disabled={busy || loading || Boolean(readError)} onValueChange={value => void save(value)} /></View>
    {error || readError ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning }}>{error ?? readError}</Text> : null}
    {permissionDenied ? <NotificationPermissionRecovery scope={database} disabled={busy || loading || Boolean(readError)} onGranted={() => save(true)} /> : null}
  </View>;
}
