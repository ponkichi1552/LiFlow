import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type PropsWithChildren } from 'react';
import { AppState, Text, View } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { GoogleSyncConnection } from '../../platform/google-tasks/google-sign-in-gateway';
import { SettingsAction, SettingsStatus } from '../../components/settings-controls';
import { palette, typography } from '../../components/planner-ui';
import { useAccountOperation } from './account-operation';
import { subscribeToGoogleAccountChanges, notifyGoogleAccountChanged } from '../google-sync/account-change-events';

type ConnectionContext = { account: GoogleSyncConnection | null; ready: boolean; loading: boolean; busy: boolean; reconnect(): Promise<boolean> };
const GoogleConnectionContext = createContext<ConnectionContext | null>(null);
export const useGoogleConnection = () => useContext(GoogleConnectionContext);

/** The settings page owns consent once. Individual features only change their own saved ON flags. */
export function GoogleConnectionProvider({ database, children }: PropsWithChildren<{ database: SQLiteDatabase }>) {
  const operation = useAccountOperation(); const alive = useRef(true), running = useRef(false), version = useRef(0);
  const scope = useRef({ database, active: true });
  const [account, setAccount] = useState<GoogleSyncConnection | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => { const current = { database, active: true }; scope.current = current; return () => { current.active = false; }; }, [database]);
  useEffect(() => {
    alive.current = true; let current = true; const reads = version;
    const read = async () => {
      if (running.current) return;
      const id = ++version.current;
      try {
        const { readGoogleSyncConnection } = await import('../../platform/google-tasks/google-sign-in-gateway');
        const value = await readGoogleSyncConnection();
        if (current && id === version.current) { setAccount(value); setError(null); }
      } catch { if (current && id === version.current) { setAccount(null); setError('Googleとの接続を確認できませんでした。'); } }
      finally { if (current && id === version.current) setLoading(false); }
    };
    void read();
    const stop = subscribeToGoogleAccountChanges(database, () => { setAccount(null); setLoading(true); void read(); });
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') void read(); });
    return () => { current = false; alive.current = false; reads.current++; stop(); foreground.remove(); };
  }, [database]);
  const reconnect = async () => {
    if (running.current || operation && !operation.acquire()) return false;
    const current = scope.current; const isCurrent = () => alive.current && current.active && current === scope.current;
    running.current = true; ++version.current; setBusy(true); setError(null);
    try {
      const { authorizeGoogleSyncConnection } = await import('../../platform/google-tasks/google-sign-in-gateway');
      const connected = await authorizeGoogleSyncConnection(); if (!isCurrent()) return false;
      const { activateCurrentGoogleTaskAccount } = await import('../google-sync/account-switch');
      if (!isCurrent()) return false;
      await activateCurrentGoogleTaskAccount(database, connected.subject); if (!isCurrent()) return false;
      notifyGoogleAccountChanged(database); setAccount(connected);
      return true;
    } catch (cause) {
      if (isCurrent()) {
        setAccount(null);
        if (!(cause instanceof Error && cause.name === 'GoogleAuthorizationCancelledError')) setError('Googleとの接続を完了できませんでした。権限を確認して再接続してください。');
      }
      return false;
    } finally { running.current = false; operation?.release(); if (isCurrent()) { setLoading(false); setBusy(false); } }
  };
  const ready = account?.authorized === true;
  return <GoogleConnectionContext.Provider value={{ account, ready, loading, busy, reconnect }}>
    <View style={{ gap: 10 }}>
      {account ? <View style={{ gap: 4 }}><Text style={{ ...typography.body, color: palette.ink }}>{account.label}</Text>
        <SettingsStatus>{ready ? 'Googleと接続済み' : 'Googleの追加認証が必要です'}</SettingsStatus></View> : null}
      {!ready ? <SettingsAction placement="page" title={busy ? 'Googleと接続中…' : loading ? 'Googleの接続を確認中…' : account ? 'Googleに再接続' : 'Googleと接続'}
        disabled={busy || loading || operation?.busy === true} onPress={() => void reconnect()} /> : null}
      {error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>{error}</Text> : null}
    </View>
    {children}
  </GoogleConnectionContext.Provider>;
}
