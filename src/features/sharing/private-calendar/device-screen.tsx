import { FormTextInput as TextInput } from '../../../components/form-text-input';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { AppButton, BackButton, Card, Page, ScreenHeading, SectionHeading, palette, typography } from '../../../components/planner-ui';
import type { PrivateCalendarDeviceSession, PrivateCalendarDeviceView } from './device-session';
import { snapshotPrivateCalendarPairingReference, verifyPrivateCalendarPairingRequest } from './pairing';
import type { PrivateCalendarPairingReference, PrivateCalendarPairingRequest } from './pairing';

type Review = { kind: 'reference'; value: PrivateCalendarPairingReference } | { kind: 'request'; value: PrivateCalendarPairingRequest }
  | { kind: 'first' } | { kind: 'main' | 'revoke'; deviceId: string; expectedDigest: string };
const phaseText = { unconfigured: '未設定', firstPending: '初回設定の送信待ち', pairing: '既存端末からの承認待ち', approved: '承認済み', revoked: 'この端末の承認は解除されています' };
function parsePublicText(text: string): unknown {
  if (text.length > 8000 || !text.trim()) throw new Error('確認情報を貼り付けてください。'); return JSON.parse(text);
}

/** Shared by the authenticated route and isolated physical QA. Opening this screen only reads local public state. */
export function PrivateCalendarDeviceScreen({ loadSession, onBack, onShare, onCalendar }: {
  loadSession: () => Promise<PrivateCalendarDeviceSession>; onBack(): void;
  onShare(value: PrivateCalendarPairingReference | PrivateCalendarPairingRequest): Promise<void>;
  onCalendar?: () => void;
}) {
  const [view, setView] = useState<PrivateCalendarDeviceView | null>(null); const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string | null>(null); const [text, setText] = useState(''); const [review, setReview] = useState<Review | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const session = useRef<PrivateCalendarDeviceSession | null>(null); const alive = useRef(true); const running = useRef(false);
  useEffect(() => {
    alive.current = true; session.current = null;
    let current = true;
    void loadSession().then(async next => { if (!current) return; const state = await next.read(); if (current) { session.current = next; setView(state); setMessage(null); } })
      .catch(() => { if (current) setMessage('本人端末の設定を読み込めませんでした。アカウントを確認して再読込してください。'); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; alive.current = false; session.current = null; };
  }, [loadSession]);
  async function run(work: (active: PrivateCalendarDeviceSession) => Promise<PrivateCalendarDeviceView>, syncAction = false) {
    if (!alive.current || running.current) return; running.current = true; setBusy(true); setMessage(null); setSyncFeedback(null);
    const active = session.current;
    try {
      const next = active ?? await loadSession(); const state = await work(next);
      if (alive.current && (!active || session.current === active)) {
        session.current = next; setView(state); setReview(null);
        if (syncAction) setSyncFeedback(state.phase !== 'approved' ? '承認状態を確認してください。新しい確認情報や元の端末での承認が必要な場合があります。'
          : state.pendingChange ? '準備した端末変更の受付に確認が必要です。' : state.pendingKeys ? '本人端末を確認しました。鍵の配布は送信待ちです。'
          : !state.keyReady ? '本人端末を確認しました。鍵の受信待ちです。' : '本人端末の設定を確認しました。');
      }
    } catch {
      if (alive.current) setMessage('操作を完了できませんでした。端末内の準備は保持しています。接続と確認情報を確認し、再読込・再試行してください。');
    } finally { running.current = false; if (alive.current) setBusy(false); }
  }
  function preview(kind: 'reference' | 'request') {
    try {
      const raw = parsePublicText(text); const value = kind === 'reference' ? snapshotPrivateCalendarPairingReference(raw as PrivateCalendarPairingReference) : verifyPrivateCalendarPairingRequest(raw as PrivateCalendarPairingRequest);
      const owner = 'anchor' in value ? value.anchor.ownerUserId : value.body.ownerUserId;
      if (owner !== view?.ownerUserId) throw new Error('別アカウント');
      setReview(kind === 'reference' ? { kind, value: value as PrivateCalendarPairingReference } : { kind, value: value as PrivateCalendarPairingRequest }); setMessage(null);
    } catch { setReview(null); setMessage('確認情報の形式・署名・アカウントが一致しません。送信元の端末から受け取った情報を確認してください。'); }
  }
  const confirm = () => run(async active => {
    if (!review) return active.read();
    if (review.kind === 'first') return active.initializeFirstDevice();
    if (review.kind === 'reference') return active.prepareConfirmedReference(review.value);
    if (review.kind === 'request') return active.approveConfirmedRequest(review.value);
    return review.kind === 'main' ? active.changeMain(review.deviceId, review.expectedDigest) : active.revokeDevice(review.deviceId, review.expectedDigest);
  });
  const share = (kind: 'reference' | 'request') => run(async active => {
    const current = await active.read(); const value = current[kind]; if (!value) throw new Error('確認情報が更新されています。'); await onShare(value); return current;
  });
  const approved = view?.phase === 'approved'; const canPrepare = view && ['unconfigured', 'firstPending', 'pairing', 'revoked'].includes(view.phase);
  return <Page header={<BackButton onPress={onBack} />}>

    <ScreenHeading title="本人用カレンダーの端末" description="本人の時間帯を利用する端末を管理します。グループの他メンバーには公開しません。" />
    {busy ? <ActivityIndicator color={palette.accent} /> : null}
    {view ? <Card><Text testID="private-device-phase" style={styles.label}>{phaseText[view.phase]}</Text>
      {view.deviceId ? <Text selectable style={styles.code} testID="private-device-id">この端末：{view.deviceId}</Text> : null}
      {approved ? <><Text style={styles.body} testID="private-device-main">{view.mainDeviceId === view.deviceId ? 'この端末がメインです。' : '別の承認済み端末がメインです。'}</Text>
        <Text style={styles.body} testID="private-device-key">{view.keyReady ? '鍵はこの端末に保存済みです。' : '鍵の受信待ちです。'}</Text></> : null}
      {view.keyVersion ? <Text style={styles.caption} testID="private-device-revision">設定 {view.revision} · 鍵 {view.keyVersion}</Text> : null}
      {view.pendingKeys > 0 ? <Text style={styles.notice}>端末に保存済み · 他の端末への鍵の配布 {view.pendingKeys}件が送信待ちです。</Text> : null}
      {view.cache ? <Text style={styles.caption}>{view.cache.authorityCurrent ? '現在の端末設定に対応する時間帯を保存済み' : '端末設定が変わったため、時間帯の更新が必要です。'}{view.cache.pending ? ' · 送信待ち' : ''}</Text> : null}
      {approved && onCalendar ? <AppButton title="Google Calendarの取得元・時間帯の同期" variant="secondary" disabled={busy} onPress={onCalendar} /> : null}
      <AppButton title="端末設定を同期" variant="secondary" disabled={busy} onPress={() => run(active => active.synchronizeDevices(), true)} />
      {syncFeedback ? <Text testID="private-device-sync-complete" accessibilityLiveRegion="polite" style={styles.caption}>{syncFeedback}</Text> : null}
    </Card> : null}
    {view?.phase === 'unconfigured' ? <Card><SectionHeading title="最初の端末として設定" />
      <Text style={styles.body}>別の本人端末で既に設定している場合は、その端末から確認情報を受け取ってください。</Text>
      <AppButton title="この端末が最初です" disabled={busy} onPress={() => setReview({ kind: 'first' })} />
    </Card> : null}
    {canPrepare ? <Card><SectionHeading title="既存の本人端末から承認を受ける" />
      <Text style={styles.body}>同じアカウントの承認済み端末から「本人端末の確認情報」を受け取り、照合します。</Text>
      <TextInput style={styles.input} multiline maxLength={8000} value={text} onChangeText={value => { setText(value); setReview(null); }} accessibilityLabel="本人端末の確認情報" placeholder="確認情報を貼り付け" autoCapitalize="none" autoCorrect={false} editable={!busy} />
      <AppButton title="確認情報を照合" disabled={busy || !text.trim()} onPress={() => preview('reference')} />
      {view.request ? <><Text selectable style={styles.code}>確認元のpin：{view.request.body.rootDigest}</Text>
        <Text style={styles.body}>依頼を元の端末へ渡し、表示された端末IDを照合して承認してください。</Text>
        <AppButton title="この端末の確認依頼を渡す" variant="secondary" disabled={busy} onPress={() => share('request')} />
        <AppButton title="承認と鍵の受信を確認" disabled={busy} onPress={() => run(active => active.acceptApproval())} />
      </> : null}
    </Card> : null}
    {approved && view.reference ? <>
      <Card><SectionHeading title="別の本人端末を承認" />
        <Text selectable style={styles.code}>信頼pin：{view.reference.anchor.rootDigest}</Text>
        <AppButton title="本人端末の確認情報を渡す" variant="secondary" disabled={busy} onPress={() => share('reference')} />
        <Text style={styles.body}>相手から届いた依頼を貼り付け、相手の画面の端末IDと照合してください。</Text>
        <TextInput style={styles.input} multiline maxLength={8000} value={text} onChangeText={value => { setText(value); setReview(null); }} accessibilityLabel="別端末の確認依頼" placeholder="確認依頼を貼り付け" autoCapitalize="none" autoCorrect={false} editable={!busy} />
        <AppButton title="確認依頼を照合" disabled={busy || !text.trim()} onPress={() => preview('request')} />
      </Card>
      <Card><SectionHeading title="承認済みの端末" />
        {view.devices.map(device => {
          const label = device.deviceId === view.deviceId ? 'この端末' : `端末 ${device.deviceId.slice(7, 15)}`;
          return <View key={device.deviceId} style={styles.device}><Text style={styles.label}>{label}{device.deviceId === view.mainDeviceId ? ' · メイン' : ''}</Text>
            <Text selectable style={styles.code}>{device.deviceId}</Text>
            {device.deviceId !== view.mainDeviceId ? <AppButton title="メインにする" accessibilityLabel={`${label}をメインにする`} compact variant="secondary" disabled={busy} onPress={() => setReview({ kind: 'main', deviceId: device.deviceId, expectedDigest: view.authorityDigest! })} /> : null}
            {device.deviceId !== view.deviceId ? <AppButton title="承認を解除" accessibilityLabel={`${label}の承認を解除`} compact variant="danger" disabled={busy} onPress={() => setReview({ kind: 'revoke', deviceId: device.deviceId, expectedDigest: view.authorityDigest! })} /> : null}
          </View>;
        })}
      </Card>
    </> : null}
    {view?.pendingChange ? <Card><SectionHeading title={view.pendingChange.reviewRequired ? '別の端末の変更を確認' : '端末変更の受付待ち'} />
      <Text style={styles.body}>この端末で準備した変更を保持しています。端末設定の同期で受付を確認できます。</Text>
      {view.pendingChange.reviewRequired ? <><Text style={styles.body}>別の変更が先に反映されています。元の案を取り下げるときは、現在の設定を確認してください。</Text>
        <AppButton title="確認済みの現在設定を採用し元の案を取り下げる" variant="secondary" disabled={busy} onPress={() => run(active => active.dismissReviewed(view.pendingChange!.digest, view.pendingChange!.observedCurrentDigest))} /></> : null}
    </Card> : null}
    {review ? <Card><SectionHeading title="操作を確認" />
      {review.kind === 'first' ? <Text style={styles.body}>この端末を本人用カレンダーの最初のメイン端末として設定します。</Text>
        : review.kind === 'reference' ? <><Text selectable style={styles.code}>確認元のpin：{review.value.anchor.rootDigest}</Text><Text style={styles.body}>元の端末に表示されたpinと一致した場合だけ、確認依頼を作成してください。</Text></>
        : review.kind === 'request' ? <><Text selectable style={styles.code}>信頼pin：{review.value.body.rootDigest}</Text><Text selectable style={styles.code}>承認する端末：{review.value.body.device.deviceId}</Text><Text style={styles.body}>相手の画面と端末IDが一致した場合だけ承認してください。</Text></>
        : <><Text selectable style={styles.code}>対象：{review.deviceId}</Text><Text style={styles.body}>{review.kind === 'main' ? 'この端末をメインへ変更します。' : `対象の端末を解除し、今後の鍵を更新します。${review.deviceId === view?.mainDeviceId ? '操作中の端末をメインへ変更します。' : ''}過去の端末保存データは削除しません。`}</Text></>}
      <AppButton title={review.kind === 'request' ? '照合した端末を承認' : review.kind === 'reference' ? '照合した情報で依頼を作成' : '確認して実行'} disabled={busy} onPress={confirm} />
      <AppButton title="操作を取りやめる" variant="quiet" disabled={busy} onPress={() => setReview(null)} />
    </Card> : null}
    {message ? <Text accessibilityRole="alert" style={styles.notice}>{message}</Text> : null}
    <AppButton title="端末内の設定を再読込" variant="quiet" disabled={busy} onPress={() => run(active => active.read())} />
  </Page>;
}
const styles = StyleSheet.create({
  body: { ...typography.body, color: palette.ink }, label: { ...typography.subheading, fontWeight: '700', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, code: { ...typography.caption, color: palette.muted, flexShrink: 1 },
  notice: { ...typography.label, color: palette.warning }, device: { gap: 8, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  input: { ...typography.body, color: palette.ink, borderWidth: 1, borderColor: palette.border, borderRadius: 14, padding: 12, minHeight: 78, textAlignVertical: 'top' },
});
