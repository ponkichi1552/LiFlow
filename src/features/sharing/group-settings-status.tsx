import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { AppButton, Card, palette, typography } from '../../components/planner-ui';
import { SettingsAction } from '../../components/settings-controls';
import { SettingsRow } from '../settings/settings-navigation';
import { groupSettingsTitles, type GroupSettingsSection } from './group-settings-sections';

export function GroupSettingsStatusRows({ active, admin, busy, pending, held, syncFailed, onOpen }: {
  active: boolean;
  admin: boolean;
  busy: boolean;
  pending: number;
  held?: number;
  syncFailed?: boolean;
  onOpen(section: GroupSettingsSection): void;
}) {
  const status = syncFailed ? '同期に失敗' : held ? `確認待ち ${held}件` : pending ? `未送信 ${pending}件` : undefined;
  return <>
    {active ? <SettingsRow title={groupSettingsTitles.requests} disabled={busy} onPress={() => onOpen('requests')} /> : null}
    {active && admin ? <SettingsRow title={groupSettingsTitles.review} disabled={busy} onPress={() => onOpen('review')} /> : null}
    <SettingsRow title={groupSettingsTitles.sync} summary={status} disabled={busy} onPress={() => onOpen('sync')} />
  </>;
}

export function GroupJoinWaiting({ code }: { code: string }) {
  return <Card>
    <Text style={styles.label}>参加の承認待ち</Text>
    <Text style={styles.caption}>管理者の画面と確認番号を照合してください。</Text>
    <Text selectable style={styles.verification}>{code}</Text>
  </Card>;
}

export function GroupSignInActions({ checking = false, busy, onGoogle, onApple }: {
  checking?: boolean; busy: boolean; onGoogle(): void; onApple?(): void;
}) {
  if (checking) return <ActivityIndicator accessibilityLabel="アカウントを確認中" color={palette.accent} />;
  return <View style={styles.syncBody}>
    <AppButton title="Googleで続ける" disabled={busy} onPress={onGoogle} />
    {onApple ? <AppButton title="Appleで続ける" variant="secondary" disabled={busy} onPress={onApple} /> : null}
  </View>;
}

export function GroupSyncStatus({ pending, held, lastSyncAt, disabled, onSync }: {
  pending: number; held?: number; lastSyncAt?: number | null; disabled: boolean; onSync(): void;
}) {
  return <View style={styles.syncBody}>
    {pending ? <Text style={styles.body}>未送信：{pending}件</Text> : null}
    {held ? <Text accessibilityRole="alert" style={styles.error}>確認待ちの変更が{held}件あります。</Text> : null}
    {lastSyncAt ? <Text style={styles.caption}>最終同期：{new Date(lastSyncAt).toLocaleString('ja-JP')}</Text> : null}
    <SettingsAction title="今すぐ同期" compact disabled={disabled} onPress={onSync} />
  </View>;
}

const styles = StyleSheet.create({
  syncBody: { gap: 12 },
  body: { ...typography.body, color: palette.ink },
  label: { ...typography.subheading, fontWeight: '700', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted },
  error: { ...typography.caption, color: palette.warning },
  verification: { ...typography.section, fontWeight: '700', color: palette.ink, fontVariant: ['tabular-nums'], letterSpacing: 1.5 },
});
