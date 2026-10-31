import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { AppButton, BackButton, Card, Page, ScreenHeading, SectionHeading, palette, typography } from '../../../components/planner-ui';
import type { PrivateCalendarRuntime } from './runtime';
import type { ReactNode } from 'react';
type State = Awaited<ReturnType<PrivateCalendarRuntime['readSettings']>>;
export function PrivateCalendarSourceScreen({ loadRuntime, onBack, onDevices, footer }: {
  loadRuntime: () => Promise<PrivateCalendarRuntime>; onBack(): void; onDevices(): void; footer?: ReactNode;
}) {
  const [view, setView] = useState<State | null>(null); const [busy, setBusy] = useState(true); const [error, setError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null); const [account, setAccount] = useState<{ subject: string; label: string } | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [stopReview, setStopReview] = useState(false); const [review, setReview] = useState<{ targetDigest: string; observedCurrentDigest: string } | null>(null);
  const runtime = useRef<PrivateCalendarRuntime | null>(null); const alive = useRef(true); const running = useRef(false);
  useEffect(() => {
    alive.current = true; let current = true;
    void loadRuntime().then(async value => { if (!current) return; const next = await value.readSettings(); if (current) { runtime.current = value; setView(next); } })
      .catch(() => { if (current) setError(true); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; alive.current = false; runtime.current = null; };
  }, [loadRuntime]);
  async function run(work: (value: PrivateCalendarRuntime) => Promise<void>) {
    if (!alive.current || running.current) return; running.current = true; setBusy(true); setError(false); setNotice(null);
    let active = runtime.current;
    try {
      active ??= await loadRuntime(); if (!alive.current) return; runtime.current = active;
      await work(active); if (!alive.current || runtime.current !== active) return;
      const next = await active.readSettings(); if (alive.current && runtime.current === active) setView(next);
    } catch {
      if (alive.current) {
        setError(true);
        try { const next = await active?.readSettings(); if (next && alive.current && runtime.current === active) setView(next); } catch { /* Preserve the prepared change; the account may have changed. */ }
      }
    } finally { running.current = false; if (alive.current) setBusy(false); }
  }
  function showResult(result: { kind: string }) {
    if (!alive.current) return;
    setNotice(result.kind === 'published' || result.kind === 'received' ? '時間帯の暗号化保存と同期を確認しました。'
      : result.kind === 'waiting' ? '端末に保存済み・再送待ちです。もう一度押すと同じ保存内容を再送します。'
      : result.kind === 'missing' ? 'メイン端末からの新しい時間帯はまだありません。予定の重複は未確認です。'
      : result.kind === 'sourceReview' ? '別のメイン端末で取得元が変更されています。Googleアカウントを確認して接続し直してください。'
      : result.kind === 'disabled' ? 'Google Calendarの取得はオフです。' : '端末の承認・取得元・変更の受付を確認してください。');
  }
  const approved = view?.device.phase === 'approved'; const main = approved && view.device.mainDeviceId === view.device.deviceId;
  return <Page header={<BackButton onPress={onBack} />}>
    <ScreenHeading title="本人用Google Calendar" description="予定名や場所は取得せず、予定がある時間帯だけを本人の推奨と重複確認に使います。" />
    {busy ? <ActivityIndicator color={palette.accent} /> : null}
    {view ? <Card><SectionHeading title={!approved ? '端末の承認が必要です' : main ? 'この端末から取得' : 'メイン端末から受信'} />
      <Text style={typography.body}>{!approved ? '本人端末の設定を確認してください。' : main ? view.connected ? '選択したGoogleアカウントを取得元にしています。' : '取得元は未設定、または取得を停止しています。' : 'Googleへの取得はメイン端末で行い、同じ本人の承認済み端末へ暗号化して同期します。'}</Text>
      {view.requiresSourceReview ? <Text style={{ ...typography.label, color: palette.warning }}>以前の取得元は自動で再開しません。本人がGoogleアカウントを確認して接続し直してください。</Text> : null}
      {view.pendingTargetDigest ? <Text style={{ ...typography.label, color: palette.warning }}>取得元の変更は端末に保存済み・受付の確認待ちです。予定の重複は未確認として扱います。</Text> : view.cacheSaved ? <Text style={typography.caption}>時間帯データがこの端末に保存されています。鮮度や取得範囲が不足する日時は未確認になります。</Text> : null}
      <AppButton title="本人端末の承認・メイン設定" variant="secondary" onPress={onDevices} />
    </Card> : null}
    {main && !view.pendingTargetDigest ? <Card><SectionHeading title="取得元のGoogleアカウント" />
      <Text style={typography.body}>端末で選択されているGoogleアカウントを確認してから接続します。共有用のログインと同じアカウントとは推測しません。</Text>
      <AppButton title="Googleアカウントを確認" variant="secondary" disabled={busy} onPress={() => run(async value => {
        const selected = await value.checkGoogleAccount(); if (alive.current) { setAccount(selected); setNeedsLogin(!selected); if (!selected) setNotice('この端末のGoogleログインを確認してください。Google Tasksで使っているアカウントがある場合は、同じアカウントを選んでください。'); }
      })} />
      {needsLogin ? <AppButton title="この端末でGoogleログインを確認" variant="secondary" disabled={busy} onPress={() => run(async value => {
        const selected = await value.restoreCurrentGoogleAccount(); if (alive.current) { setAccount(selected); setNeedsLogin(false); }
      })} /> : null}
      {account ? <><Text style={typography.label}>{account.label}</Text><Text style={typography.caption}>このアカウントの時間帯の読取を許可し、取得元として保存します。Google Tasksの登録先や紐付けは変更しません。</Text>
        <AppButton title="このアカウントで接続" disabled={busy} onPress={() => run(async value => {
          const result = await value.connectCurrentSource(account.subject, view.device.authorityDigest!);
          if (result.kind === 'review') { if (alive.current) setReview(result); return; } showResult(await value.refreshData());
        })} /></> : null}
      {view.connected ? <AppButton title="Google Calendarの取得を停止" variant="quiet" disabled={busy} onPress={() => setStopReview(true)} /> : null}
    </Card> : null}
    {approved && !view.pendingTargetDigest ? <AppButton title={main ? '最新の時間帯を取得・同期' : 'メイン端末の時間帯を同期'} disabled={busy || main && !view.connected}
      onPress={() => run(async value => { showResult(await value.refreshData()); })} /> : null}
    {view?.pendingTargetDigest ? <Card><SectionHeading title="取得元の変更を確認" />
      <AppButton title="保存した変更の受付を確認・再開" disabled={busy} onPress={() => run(async value => {
        const result = await value.resumeSource(); if (alive.current) { setReview(result.kind === 'review' ? result : null); setNotice(result.kind === 'review' ? '別の端末の設定が先に反映されています。元の取得元の変更を確認してください。' : '取得元の設定を確認しました。'); }
      })} />
      {review ? <AppButton title="確認した現在設定を採用して元の案を取り下げる" variant="secondary" disabled={busy} onPress={() => run(async value => {
        await value.dismissSource(review.targetDigest, review.observedCurrentDigest); if (alive.current) { setReview(null); setNotice('元の案を取り下げました。以前に保存した取得元は保持しています。'); }
      })} /> : null}
    </Card> : null}
    {stopReview ? <Card><SectionHeading title="時間帯の取得を停止しますか？" /><Text style={typography.body}>以前の時間帯を今の予定と見なさないようにします。Google Tasksの権限・登録先や家事の履歴は変更しません。</Text>
      <AppButton title="確認して取得を停止" disabled={busy} onPress={() => run(async value => {
        const result = await value.disableSource(view!.device.authorityDigest!); if (alive.current) { setStopReview(false); setAccount(null); setNotice(result.kind === 'ready' ? '時間帯の取得を停止しました。' : '取得元の変更の受付を確認してください。'); }
      })} /><AppButton title="取得を続ける" variant="quiet" disabled={busy} onPress={() => setStopReview(false)} /></Card> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={typography.body}>{notice}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={{ ...typography.label, color: palette.warning }}>操作を完了できませんでした。準備した変更や保存済みデータは保持しています。接続先のGoogleアカウント・権限と端末設定を確認して再試行してください。</Text> : null}
    <AppButton title="取得元の設定を再読込" variant="quiet" disabled={busy} onPress={() => run(async () => {})} />
    {footer}
  </Page>;
}
