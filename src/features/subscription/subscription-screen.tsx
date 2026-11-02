import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { AppButton, BackButton, Card, Page, ScreenHeading, palette, typography } from '../../components/planner-ui';
import { subscriptionSnapshot, subscribeSubscription, refreshSubscription, startSubscriptions } from '../../platform/subscription/runtime';

type Purchases = typeof import('../../platform/subscription/purchases');
const empty = { product: null, busy: false, pending: false, message: null };
const observeEmpty = () => () => undefined;
export function SubscriptionScreen({ onBack }: { onBack?: () => void }) {
  const subscription = useSyncExternalStore(subscribeSubscription, subscriptionSnapshot, subscriptionSnapshot);
  const [purchases, setPurchases] = useState<Purchases | null>(null); const [message, setMessage] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [providerState, setProviderState] = useState<{ userId: string; canLinkGoogle: boolean } | null>(null);
  const canLinkGoogle = providerState?.userId === subscription.userId && providerState.canLinkGoogle;
  const store = useSyncExternalStore(purchases?.observeSubscriptionPurchases ?? observeEmpty,
    purchases?.subscriptionPurchaseSnapshot ?? (() => empty), purchases?.subscriptionPurchaseSnapshot ?? (() => empty));
  useEffect(() => { void startSubscriptions(); }, []);
  useEffect(() => {
    if (!subscription.userId) return;
    let live = true;
    if (Platform.OS === 'ios') void import('../../platform/sharing/auth').then(async auth => {
      const providers = await auth.sharingAccountProviders(subscription.userId!);
      if (live) setProviderState({ userId: subscription.userId!, canLinkGoogle: providers.includes('apple.com') && !providers.includes('google.com') });
    }).catch(() => undefined);
    void import('../../platform/subscription/purchases').then(async module => {
      if (!live) return; setPurchases(module); await module.startSubscriptionPurchases(subscription.userId!);
    }).catch(() => { if (live) setMessage('ストアでの購入・復元は準備中です。'); });
    return () => { live = false; };
  }, [subscription.userId]);
  useEffect(() => { const listener = AppState.addEventListener('change', next => { if (next === 'active') void refreshSubscription(); }); return () => listener.remove(); }, []);
  const login = async (apple: boolean) => {
    if (loginBusy) return; setLoginBusy(true); setMessage(null);
    try { const auth = await import('../../platform/sharing/auth'); if (apple) await auth.signInSharingWithApple(); else await auth.signInSharingWithGoogle(); }
    catch { setMessage('ログインを完了できませんでした。'); } finally { setLoginBusy(false); }
  };
  const active = subscription.phase === 'active';
  const linkGoogle = async () => {
    if (loginBusy) return; setLoginBusy(true); setMessage(null);
    try { const user = await (await import('../../platform/sharing/auth')).linkSharingWithGoogle(); setProviderState({ userId: user.uid, canLinkGoogle: false }); setMessage('Androidでも同じGoogleでログインできます。'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Googleとの紐づけを完了できませんでした。'); }
    finally { setLoginBusy(false); }
  };
  const paymentPending = store.pending || Boolean(subscription.entitlement && ['pending', 'onHold'].includes(subscription.entitlement.body.status));
  const legal = { terms: process.env.EXPO_PUBLIC_LIFLOW_TERMS_URL, privacy: process.env.EXPO_PUBLIC_LIFLOW_PRIVACY_URL };
  const ready = Boolean(legal.terms && legal.privacy && store.product && purchases);
  return <Page header={onBack ? <BackButton onPress={onBack} /> : undefined}>
    <ScreenHeading title={active ? 'LiFlowの契約' : 'LiFlowを利用する'} />
    <Card><Text style={styles.title}>{active ? '利用できます' : '1人分の月額プラン'}</Text>
      {active && subscription.entitlement ? <Text style={styles.body}>有効期限：{new Date(subscription.entitlement.body.expiresAt).toLocaleDateString('ja-JP')}</Text> : null}
      <Text style={styles.body}>家事・カレンダー・共有・家電のお手入れを利用できます。</Text>
      {!subscription.userId ? <>
        <AppButton title={loginBusy ? 'ログイン中…' : 'Googleでログイン'} disabled={loginBusy} onPress={() => void login(false)} />
        {Platform.OS === 'ios' && process.env.EXPO_PUBLIC_APPLE_SHARING_ENABLED === 'true' ? <AppButton title="Appleでログイン" variant="secondary" disabled={loginBusy} onPress={() => void login(true)} /> : null}
      </> : active || paymentPending ? <AppButton title="契約・支払いを確認" variant="secondary" onPress={() => void purchases?.manageSubscription().catch(() => setMessage('購入元のストアで契約を確認してください。'))} /> : <>
        <AppButton title={store.busy ? '購入を確認中…' : store.product ? `月額${store.product.price}で利用する` : '購入の準備中'} disabled={!ready || store.busy}
          onPress={() => void purchases?.purchaseSubscription()} />
        <Text style={styles.note}>解約するまで毎月自動更新されます。解約後も支払い済みの期限までは利用できます。</Text>
      </>}
      {subscription.userId ? <>
        {canLinkGoogle ? <AppButton title="Androidでも同じ契約を使う：Googleと紐づける" variant="quiet" disabled={loginBusy || store.busy} onPress={() => void linkGoogle()} /> : null}
        <AppButton title="購入を復元" variant="quiet" disabled={store.busy || !purchases} onPress={() => void purchases?.restoreSubscription()} />
        <AppButton title="契約状態を確認" variant="quiet" disabled={store.busy} onPress={() => void refreshSubscription({ force: true })} />
      </> : null}
    </Card>
    {message || store.message || subscription.error ? <Text accessibilityRole="alert" style={styles.note}>{message ?? store.message ?? subscription.error}</Text> : null}
    <Text style={styles.note}>契約が切れても端末内のデータやGoogleカレンダーの予定は削除されません。アプリの削除は解約にはなりません。</Text>
    <View style={styles.links}>
      {legal.terms ? <AppButton title="利用規約" variant="quiet" onPress={() => void Linking.openURL(legal.terms!)} /> : null}
      {legal.privacy ? <AppButton title="プライバシー" variant="quiet" onPress={() => void Linking.openURL(legal.privacy!)} /> : null}
    </View>
    {subscription.userId ? <AppButton title="アカウントを変更" variant="quiet" onPress={() => { void import('../../platform/sharing/auth').then(module => module.signOutSharing()).catch(() => setMessage('ログアウトを完了できませんでした。')); }} /> : null}
  </Page>;
}
const styles = StyleSheet.create({ title: { ...typography.section, color: palette.ink }, body: { ...typography.body, color: palette.ink },
  note: { ...typography.caption, color: palette.muted }, links: { flexDirection: 'row', flexWrap: 'wrap' } });
