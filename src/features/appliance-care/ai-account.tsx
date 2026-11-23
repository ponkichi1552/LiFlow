import { bindApplianceAccount } from '../../platform/appliance-care/auth';
import { useEffect, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import { SettingsAction } from '../../components/settings-controls';
import { isSharingConfigured } from '../../platform/sharing/firebase-services';
import { isSharingAppleSignInAvailable, observeSharingUser, signInSharingWithApple, signInSharingWithGoogle } from '../../platform/sharing/auth';
import type { ApplianceCareUsage } from './api-contracts';

/** Identity only: signing in here never creates or joins a sharing workspace. */
export function ApplianceAiAccount({ disabled, visible = true, onReady, usageOverride }: {
  disabled?: boolean; visible?: boolean; onReady?: (ready: boolean) => void; usageOverride?: ApplianceCareUsage;
}) {
  const configured = isSharingConfigured() && Boolean(process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim());
  const [name, setName] = useState<string | null>(null); const [apple, setApple] = useState(false);
  const [usage, setUsage] = useState<ApplianceCareUsage | null>(null);
  const resetsAt = usage?.resetsAt;
  const displayedUsage = usageOverride?.resetsAt === resetsAt ? usageOverride ?? usage : usage;
  const remaining = displayedUsage?.remaining ?? null;
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0); const [checking, setChecking] = useState(false);
  useEffect(() => {
    onReady?.(false);
    if (!configured) return;
    void isSharingAppleSignInAvailable().then(setApple).catch(() => undefined);
    let generation = 0;
    const stop = observeSharingUser(user => {
      const current = ++generation; setUsage(null); setError(null); onReady?.(false); setChecking(Boolean(user && !user.isAnonymous));
      setName(user && !user.isAnonymous ? user.email ?? 'ログイン済み' : null);
      if (!user || user.isAnonymous) return;
      void bindApplianceAccount(user.uid).then(next => { if (current === generation) { setUsage(next); setError(null); onReady?.(true); } })
        .catch(error => {
          if (current === generation) setError(error instanceof Error && 'code' in error && ['REINSTALL_ACCOUNT_LOCKED', 'DEVICE_VERIFICATION_TEMPORARY', 'SUBSCRIPTION_REQUIRED'].includes(String(error.code))
            ? error.message : '解析に接続できませんでした。');
        })
        .finally(() => { if (current === generation) setChecking(false); });
    });
    return () => { generation++; stop(); };
  }, [configured, onReady, retry]);
  useEffect(() => {
    if (!resetsAt) return;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && Date.parse(resetsAt) <= Date.now()) {
        setUsage(null); setRetry(value => value + 1);
      }
    });
    return () => subscription.remove();
  }, [resetsAt]);
  const login = async (provider: 'google' | 'apple') => {
    if (busy || disabled) return; setBusy(true); setError(null);
    try { await (provider === 'google' ? signInSharingWithGoogle() : signInSharingWithApple()); }
    catch { setError('ログインを完了できませんでした。通信状態とアカウントを確認してください。'); }
    finally { setBusy(false); }
  };
  if (!configured) return <Text style={[typography.caption, { color: palette.muted }]}>家電AIは準備中です。</Text>;
  if (!visible) return null;
  return <View style={{ gap: 8 }}>
    {!name ? <Text style={[typography.caption, { color: palette.muted }]}>解析にはログインが必要です。</Text> : null}
    {checking && !error ? <Text accessibilityLiveRegion="polite" style={[typography.caption, { color: palette.muted }]}>家電AIの利用を確認中…</Text> : null}
    {remaining !== null ? <Text style={[typography.caption, { color: palette.muted }]}>今月あと{remaining}回（月5回）</Text> : null}
    {!name ? <><AppButton title="Googleでログイン" variant="secondary" disabled={disabled || busy} onPress={() => void login('google')} />
      {apple ? <AppButton title="Appleでログイン" variant="secondary" disabled={disabled || busy} onPress={() => void login('apple')} /> : null}</> : null}
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
    {error && name ? <SettingsAction title={checking ? '接続を確認しています…' : '接続を再確認'} placement="page" disabled={disabled || busy || checking}
      onPress={() => { if (!checking && !disabled && !busy) { setChecking(true); setRetry(value => value + 1); } }} /> : null}
  </View>;
}
