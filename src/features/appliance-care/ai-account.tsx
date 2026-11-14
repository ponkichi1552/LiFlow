import { bindApplianceAccount } from '../../platform/appliance-care/auth';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import { SettingsAction } from '../../components/settings-controls';
import { isSharingConfigured } from '../../platform/sharing/firebase-services';
import { isSharingAppleSignInAvailable, observeSharingUser, signInSharingWithApple, signInSharingWithGoogle } from '../../platform/sharing/auth';

/** Identity only: signing in here never creates or joins a sharing workspace. */
export function ApplianceAiAccount({ disabled, onReady, remainingOverride }: { disabled?: boolean; onReady?: (ready: boolean) => void; remainingOverride?: number }) {
  const [name, setName] = useState<string | null>(null); const [apple, setApple] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0); const [checking, setChecking] = useState(false);
  useEffect(() => {
    onReady?.(false);
    if (!isSharingConfigured()) return;
    void isSharingAppleSignInAvailable().then(setApple).catch(() => undefined);
    let generation = 0;
    const stop = observeSharingUser(user => {
      const current = ++generation; setRemaining(null); onReady?.(false); setChecking(Boolean(user && !user.isAnonymous));
      setName(user && !user.isAnonymous ? user.email ?? 'ログイン済み' : null);
      if (!user || user.isAnonymous) return;
      void bindApplianceAccount(user.uid).then(usage => { if (current === generation) { setRemaining(usage.remaining); setError(null); onReady?.(true); } })
        .catch(() => { if (current === generation) setError('解析に接続できませんでした。'); })
        .finally(() => { if (current === generation) setChecking(false); });
    });
    return () => { generation++; stop(); };
  }, [onReady, retry]);
  const login = async (provider: 'google' | 'apple') => {
    if (busy || disabled) return; setBusy(true); setError(null);
    try { await (provider === 'google' ? signInSharingWithGoogle() : signInSharingWithApple()); }
    catch { setError('ログインを完了できませんでした。通信状態とアカウントを確認してください。'); }
    finally { setBusy(false); }
  };
  return <View style={{ gap: 8 }}>
    {!name ? <Text style={[typography.caption, { color: palette.muted }]}>解析にはログインが必要です。</Text> : null}
    {remaining !== null ? <Text style={[typography.caption, { color: palette.muted }]}>今月あと{remainingOverride ?? remaining}回（月5回）</Text> : null}
    {!name ? <><AppButton title="Googleでログイン" variant="secondary" disabled={disabled || busy || !isSharingConfigured()} onPress={() => void login('google')} />
      {apple ? <AppButton title="Appleでログイン" variant="secondary" disabled={disabled || busy} onPress={() => void login('apple')} /> : null}</> : null}
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
    {error && name ? <SettingsAction title={checking ? '接続を確認しています…' : '接続を再確認'} placement="page" disabled={disabled || busy || checking}
      onPress={() => { if (!checking && !disabled && !busy) { setChecking(true); setRetry(value => value + 1); } }} /> : null}
  </View>;
}
