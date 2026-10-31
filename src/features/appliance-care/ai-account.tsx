import { bindApplianceAccount } from '../../platform/appliance-care/auth';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import { isSharingConfigured } from '../../platform/sharing/firebase-services';
import { isSharingAppleSignInAvailable, observeSharingUser, signInSharingWithApple, signInSharingWithGoogle } from '../../platform/sharing/auth';

/** Identity only: signing in here never creates or joins a sharing workspace. */
export function ApplianceAiAccount({ disabled, onReady }: { disabled?: boolean; onReady?: (ready: boolean) => void }) {
  const [name, setName] = useState<string | null>(null); const [apple, setApple] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    onReady?.(false);
    if (!isSharingConfigured()) return;
    void isSharingAppleSignInAvailable().then(setApple).catch(() => undefined);
    let generation = 0;
    const stop = observeSharingUser(user => {
      const current = ++generation; setRemaining(null); onReady?.(false);
      setName(user && !user.isAnonymous ? user.email ?? 'ログイン済み' : null);
      if (!user || user.isAnonymous) return;
      void bindApplianceAccount(user.uid).then(usage => { if (current === generation) { setRemaining(usage.remaining); setError(null); onReady?.(true); } })
        .catch(() => { if (current === generation) setError('端末との紐づけは未確認です。確認ができるまで家電AIは利用できません。'); });
    });
    return () => { generation++; stop(); };
  }, [onReady]);
  const login = async (provider: 'google' | 'apple') => {
    if (busy || disabled) return; setBusy(true); setError(null);
    try { await (provider === 'google' ? signInSharingWithGoogle() : signInSharingWithApple()); }
    catch { setError('ログインを完了できませんでした。通信状態とアカウントを確認してください。'); }
    finally { setBusy(false); }
  };
  return <View style={{ gap: 8 }}>
    <Text style={[typography.caption, { color: palette.muted }]}>{name ? `家電AIのアカウント：${name}` : '家電AIの実行にはGoogleまたはAppleでのログインが必要です。家事管理と保存済み説明の閲覧はログイン不要です。'}</Text>
    {remaining !== null ? <Text style={[typography.caption, { color: palette.muted }]}>確認済みの残回数：今月{remaining}回</Text> : null}
    {!name ? <><AppButton title="Googleでログイン" variant="secondary" disabled={disabled || busy || !isSharingConfigured()} onPress={() => void login('google')} />
      {apple ? <AppButton title="Appleでログイン" variant="secondary" disabled={disabled || busy} onPress={() => void login('apple')} /> : null}</> : null}
    <Text style={[typography.caption, { color: palette.muted }]}>正規アプリ・端末の継続性を確認できない環境では解析できません。ログインだけでは利用可能になりません。</Text>
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
  </View>;
}
