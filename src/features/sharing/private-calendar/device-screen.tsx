import { FormTextInput as TextInput } from '../../../components/form-text-input';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { Page, SectionHeading, palette, typography } from '../../../components/planner-ui';
import { SettingsPanel, SettingsSegments, SettingsAction, SettingsStatus } from '../../../components/settings-controls';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { SettingsHeader } from '../../settings/settings-navigation';
import { useAccountOperation } from '../../settings/account-operation';
import type { PrivateCalendarDeviceSession, PrivateCalendarDeviceView } from './device-session';
import type { PrivateCalendarPairingReference, PrivateCalendarPairingRequest } from './pairing';
import { decodeConnectionCode } from './connection-code';

type Review = { kind: 'main' | 'revoke'; deviceId: string; expectedDigest: string };
const phaseText = { unconfigured: '未設定', firstPending: '初回設定の送信待ち', pairing: '接続元の端末の応答待ち', approved: '接続済み', revoked: 'この端末の接続は解除されています' };

/** Shared by the authenticated route and isolated physical QA. Opening this screen only reads local public state. */
export function PrivateCalendarDeviceScreen({ loadSession, onBack, onShare, embedded = false, synchronization }: {
  loadSession: () => Promise<PrivateCalendarDeviceSession>; onBack(): void;
  onShare(value: PrivateCalendarPairingReference | PrivateCalendarPairingRequest | string): Promise<void>;
  embedded?: boolean;
  synchronization?: ReactNode;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  const operation = useAccountOperation();
  const [setupChoice, setSetupChoice] = useState<'first' | 'pair'>('first');
  const [view, setView] = useState<PrivateCalendarDeviceView | null>(null); const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string | null>(null); const [text, setText] = useState(''); const [review, setReview] = useState<Review | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const session = useRef<PrivateCalendarDeviceSession | null>(null); const alive = useRef(true); const running = useRef(false); const viewRead = useRef(0);
  useEffect(() => {
    alive.current = true; session.current = null;
    let current = true; let unsubscribe: (() => void) | undefined, stopConnections: (() => void) | undefined;
    void loadSession().then(async next => { if (!current) return; const state = await next.read(); if (current) {
      session.current = next; setView(state); setMessage(null);
      unsubscribe = next.subscribe?.(() => { const version = ++viewRead.current; void next.read().then(value => { if (current && version === viewRead.current) setView(value); }).catch(() => {}); });
      stopConnections = next.observeConnections?.();
    } })
      .catch(() => { if (current) setMessage('本人端末の設定を読み込めませんでした。アカウントを確認して再読込してください。'); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; alive.current = false; session.current = null; unsubscribe?.(); stopConnections?.(); };
  }, [loadSession]);
  async function run(work: (active: PrivateCalendarDeviceSession) => Promise<PrivateCalendarDeviceView>, syncAction = false) {
    if (!alive.current || running.current || operation && !operation.acquire()) return; running.current = true; setBusy(true); setMessage(null); setSyncFeedback(null);
    const active = session.current;
    try {
      const next = active ?? await loadSession(); const state = await work(next);
      if (alive.current && (!active || session.current === active)) {
        ++viewRead.current; session.current = next; setView(state); setReview(null);
        if (syncAction) setSyncFeedback(state.phase !== 'approved' ? '接続元の端末の応答待ちです。接続コードが期限切れの場合は、新しいコードを受け取ってください。'
          : state.pendingChange ? '準備した端末変更の受付に確認が必要です。' : state.pendingKeys ? '本人端末を確認しました。鍵の配布は送信待ちです。'
          : !state.keyReady ? '本人端末を確認しました。鍵の受信待ちです。' : '本人端末の設定を確認しました。');
      }
    } catch {
      if (alive.current) setMessage('接続を完了できませんでした。コードと通信状態を確認して、再試行してください。');
    } finally { operation?.release(); running.current = false; if (alive.current) setBusy(false); }
  }
  const confirm = () => run(async active => {
    if (!review) return active.read();
    return review.kind === 'main' ? active.changeMain(review.deviceId, review.expectedDigest) : active.revokeDevice(review.deviceId, review.expectedDigest);
  });
  const shareCode = () => run(async active => { const code = await active.issueConnectionCode(); await onShare(code); return active.read(); });
  function receiveCode(value: string) {
    setText(value);
    try {
      // Only a complete same-account capability starts work. Opening, partial input and drafts remain read-only.
      if (decodeConnectionCode(value).grant.body.reference.anchor.ownerUserId !== view?.ownerUserId) return;
    } catch { return; }
    return run(active => active.connectWithCode(value));
  }
  const approved = view?.phase === 'approved'; const canPrepare = view && ['unconfigured', 'firstPending', 'pairing', 'revoked'].includes(view.phase);
  const disabled = busy || operation?.busy === true;
  const needsRetry = Boolean(message || view && view.phase !== 'unconfigured' && (!approved || !view.keyReady || view.pendingChange || view.pendingKeys));
  const reviewPanel = review ? <SettingsPanel><View style={styles.review}><SectionHeading title="内容を確認" />
    <Text selectable style={styles.code}>対象：{review.deviceId}</Text>
    <Text style={styles.body}>{review.kind === 'main' ? 'この端末をメインへ変更します。' : `対象の端末を解除し、今後の鍵を更新します。${review.deviceId === view?.mainDeviceId ? '操作中の端末をメインへ変更します。' : ''}過去の端末保存データは削除しません。`}</Text>
    <View style={styles.actions}><SettingsAction placement={embedded ? 'panel' : 'page'} title="確認して実行" compact disabled={disabled} onPress={confirm} />
      <SettingsAction placement={embedded ? 'panel' : 'page'} title="操作を取りやめる" compact disabled={disabled} onPress={() => setReview(null)} /></View>
  </View></SettingsPanel> : null;
  const content = <>
    {busy ? <ActivityIndicator color={palette.accent} /> : null}
    {view && view.phase !== 'unconfigured' ? <View style={styles.status}>
      <SettingsStatus testID="private-device-phase">{approved && !view.keyReady ? '接続処理中' : phaseText[view.phase]}</SettingsStatus>
      {view.pendingKeys > 0 ? <Text style={styles.notice}>追加した端末への接続待ちです。</Text> : null}
      {needsRetry ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="再試行" accessibilityLabel="端末設定を同期" compact disabled={disabled} onPress={() => run(active => active.synchronizeDevices(), true)} /> : null}
      {syncFeedback ? <Text testID="private-device-sync-complete" accessibilityLiveRegion="polite" style={styles.caption}>{syncFeedback}</Text> : null}
    </View> : null}
    {approved && synchronization ? <View key={`${view.authorityDigest}:${view.keyReady}`}>{synchronization}</View> : null}
    {view?.phase === 'unconfigured' ? <View style={styles.setup}>
      <SettingsSegments fullWidth options={[{ id: 'first', label: '初めて設定' }, { id: 'pair', label: '端末を追加' }]} value={setupChoice} disabled={disabled}
        onValueChange={value => { setSetupChoice(value); setReview(null); }} />
      {setupChoice === 'first' ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="同期を設定する" compact disabled={disabled} onPress={() => run(active => active.initializeFirstDevice())} /> : null}
    </View> : null}
    {canPrepare && (view.phase !== 'unconfigured' || setupChoice === 'pair') ? <View style={styles.section}>
      <Text style={styles.caption}>同じアカウントの接続コードを貼り付けると同期します。</Text>
      <TextInput style={[styles.input, embedded && { backgroundColor: colors.surface }]} multiline maxLength={8000} value={text} onChangeText={receiveCode} accessibilityLabel="端末の接続コード" placeholder="接続コードを貼り付け" autoCapitalize="none" autoCorrect={false} editable={!disabled} />
      <SettingsAction placement={embedded ? 'panel' : 'page'} title="同期する" compact disabled={disabled || !text.trim()} onPress={() => run(active => active.connectWithCode(text))} />
      {view.phase === 'pairing' && view.connectionExpired ? <Text accessibilityRole="alert" style={styles.notice}>接続が完了しない場合は、新しいコードを受け取ってください。</Text> : null}
    </View> : null}
    {approved && view.reference ? <>
      <View style={styles.section}>
        <Text style={styles.caption}>同じアカウントの端末へ。10分有効・1回限り。</Text>
        <SettingsAction placement={embedded ? 'panel' : 'page'} title="接続コードを共有" compact disabled={disabled || !view.keyReady} onPress={shareCode} />
      </View>
      {view.devices.length > 1 ? <View style={styles.section}><SectionHeading title="接続中の端末" level="subsection" />
        {view.devices.map(device => {
          const label = device.deviceId === view.deviceId ? 'この端末' : `端末 ${device.deviceId.slice(7, 15)}`;
          return <View key={device.deviceId} style={[styles.device, { borderBottomColor: colors.border }]}>
            <View style={styles.statusTop}><Text style={styles.body}>{label}</Text>{device.deviceId === view.mainDeviceId ? <Text style={styles.caption}>メイン</Text> : null}</View>
            <View style={styles.actions}>{device.deviceId !== view.mainDeviceId ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="メインにする" accessibilityLabel={`${label}をメインにする`} compact disabled={disabled} onPress={() => setReview({ kind: 'main', deviceId: device.deviceId, expectedDigest: view.authorityDigest! })} /> : null}
              {device.deviceId !== view.deviceId ? <SettingsAction intent="destructive" placement={embedded ? 'panel' : 'page'} title="承認を解除" accessibilityLabel={`${label}の承認を解除`} compact disabled={disabled} onPress={() => setReview({ kind: 'revoke', deviceId: device.deviceId, expectedDigest: view.authorityDigest! })} /> : null}</View>
          </View>;
        })}
      </View> : null}
      {review?.kind === 'main' || review?.kind === 'revoke' ? reviewPanel : null}
    </> : null}
    {view?.pendingChange ? <SettingsPanel><View style={styles.review}><SectionHeading title={view.pendingChange.reviewRequired ? '別の端末の変更を確認' : '端末変更の受付待ち'} />
      <Text style={styles.body}>この端末で準備した変更を保持しています。端末設定の同期で受付を確認できます。</Text>
      {view.pendingChange.reviewRequired ? <><Text style={styles.body}>別の変更が先に反映されています。元の案を取り下げるときは、現在の設定を確認してください。</Text>
        <SettingsAction placement={embedded ? 'panel' : 'page'} title="確認済みの現在設定を採用し元の案を取り下げる" disabled={disabled} onPress={() => run(active => active.dismissReviewed(view.pendingChange!.digest, view.pendingChange!.observedCurrentDigest))} /></> : null}
    </View></SettingsPanel> : null}
    {message ? <Text accessibilityRole="alert" style={styles.notice}>{message}</Text> : null}
    {!view || message && view.phase === 'unconfigured' ? <View style={styles.actions}><SettingsAction placement={embedded ? 'panel' : 'page'} title="再読込" accessibilityLabel="端末内の設定を再読込" compact disabled={disabled} onPress={() => run(active => active.read())} /></View> : null}
  </>;
  return embedded ? <View style={styles.embedded}>{content}</View>
    : <Page header={<SettingsHeader title="同期する端末" onBack={onBack} />}>{content}</Page>;
}
const styles = StyleSheet.create({
  body: { ...typography.body, color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, code: { ...typography.caption, color: palette.muted, flexShrink: 1 },
  notice: { ...typography.label, color: palette.warning }, device: { gap: 8, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  status: { gap: 8 }, statusTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  setup: { gap: 18 }, section: { gap: 12 }, review: { paddingVertical: 12, gap: 12 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { ...typography.body, color: palette.ink, backgroundColor: palette.elevated, borderRadius: 12, padding: 12, minHeight: 78, textAlignVertical: 'top' },
  embedded: { gap: 14 },
});
