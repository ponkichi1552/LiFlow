import { Text, View } from 'react-native';
import { SettingsCheckbox } from '../../components/settings-checkbox';
import { SettingsAction, SettingsStatus } from '../../components/settings-controls';
import { palette, typography } from '../../components/planner-ui';
import type { GoogleSyncState } from '../google-sync/contracts';
import { useGoogleConnection } from './google-connection';

export function AccountPersonalGoogleTasks({ state, busy, loaded, error, shared, onToggle, onSync }: {
  state: GoogleSyncState | null; busy: boolean; loaded: boolean; error?: string | null; shared: boolean;
  onToggle(enabled: boolean, selectedSubject?: string): void; onSync(): void;
}) {
  const connection = useGoogleConnection();
  const enabled = state?.enabled === true && !state.disconnected;
  const connected = connection?.ready && connection.account?.subject === state?.accountSubject;
  const disabled = busy || connection?.busy || !loaded;
  return <View style={{ gap: 10 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ ...typography.label, color: palette.ink, fontWeight: '700', flex: 1 }}>{shared ? '個人の家事' : '家事の同期'}</Text>
      <SettingsCheckbox accessibilityLabel="Google Tasksの自動同期" value={enabled} disabled={disabled || !connection?.ready && !enabled}
        onValueChange={value => onToggle(value, value ? connection?.account?.subject : state?.accountSubject)} />
    </View>
    <Text style={{ ...typography.caption, color: palette.muted }}>家事をGoogleのチェックリストへ同期。</Text>
    {enabled ? <><SettingsStatus>{!connected || state.status === 'authRequired' ? 'Googleの再接続が必要です' : state.status === 'syncing' ? '同期中…'
      : state.status === 'retryPending' ? '再試行待ち' : state.status === 'error' ? '同期エラー' : '有効'}
    </SettingsStatus>
      <SettingsAction placement="panel" title={connected && state.status !== 'authRequired' ? '今すぐ同期' : 'Googleに再接続'} disabled={disabled}
        onPress={() => {
          if (!connected || state.status === 'authRequired') void connection?.reconnect().then(account => { if (account) onToggle(true, account.subject); });
          else onSync();
        }} />
    </> : null}
    {error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>{error}</Text> : null}
  </View>;
}
