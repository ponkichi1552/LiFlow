import { SettingsAction, SettingsStatus } from '../../../components/settings-controls';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View, useColorScheme } from 'react-native';
import { Page, SectionHeading, palette, typography } from '../../../components/planner-ui';
import type { PrivateCalendarRuntime } from './runtime';
import type { ReactNode } from 'react';
import { SettingsHeader } from '../../settings/settings-navigation';
import { useAccountOperation } from '../../settings/account-operation';
import { plannerColorsForScheme } from '../../../components/planner-theme';
type State = Awaited<ReturnType<PrivateCalendarRuntime['readSettings']>>;
export function PrivateCalendarSourceScreen({ loadRuntime, onBack, onDevices, footer, embedded = false }: {
  loadRuntime: () => Promise<PrivateCalendarRuntime>; onBack(): void; onDevices(): void; footer?: ReactNode; embedded?: boolean;
}) {
  const operation = useAccountOperation(), colors = plannerColorsForScheme(useColorScheme());
  const [view, setView] = useState<State | null>(null); const [busy, setBusy] = useState(true); const [error, setError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null); const [account, setAccount] = useState<{ subject: string; label: string } | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [stopReview, setStopReview] = useState(false); const [review, setReview] = useState<{ targetDigest: string; observedCurrentDigest: string } | null>(null);
  const runtime = useRef<PrivateCalendarRuntime | null>(null); const alive = useRef(true); const running = useRef(false); const readVersion = useRef(0);
  useEffect(() => {
    alive.current = true; let current = true; let stop: (() => void) | undefined;
    const read = async (value: PrivateCalendarRuntime) => {
      const version = ++readVersion.current; const next = await value.readSettings();
      if (current && version === readVersion.current) { runtime.current = value; setView(next); }
    };
    void loadRuntime().then(async value => { if (!current) return; await read(value);
      if (current) stop = value.subscribe?.(() => { void read(value).catch(() => {}); });
    }).catch(() => { if (current) setError(true); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; alive.current = false; runtime.current = null; stop?.(); };
  }, [loadRuntime]);
  async function run(work: (value: PrivateCalendarRuntime) => Promise<void>) {
    if (!alive.current || running.current || operation && !operation.acquire()) return; running.current = true; setBusy(true); setError(false); setNotice(null);
    let active = runtime.current;
    try {
      active ??= await loadRuntime(); if (!alive.current) return; runtime.current = active;
      await work(active); if (!alive.current || runtime.current !== active) return;
      const next = await active.readSettings(); if (alive.current && runtime.current === active) { ++readVersion.current; setView(next); }
    } catch {
      if (alive.current) {
        setError(true);
        try { const next = await active?.readSettings(); if (next && alive.current && runtime.current === active) setView(next); } catch { /* Preserve the prepared change; the account may have changed. */ }
      }
    } finally { operation?.release(); running.current = false; if (alive.current) setBusy(false); }
  }
  function showResult(result: { kind: string }) {
    if (!alive.current) return;
    setNotice(result.kind === 'published' || result.kind === 'received' ? '空き時間を更新しました。'
      : result.kind === 'waiting' ? '保存済み・再送待ちです。通信後に再試行します。'
      : result.kind === 'missing' ? '同期できる空き時間はまだありません。'
      : result.kind === 'sourceReview' ? 'Googleアカウントを確認して接続し直してください。'
      : result.kind === 'disabled' ? '空き時間の同期はオフです。' : '接続状態を確認してください。');
  }
  const approved = view?.device.phase === 'approved'; const main = approved && view.device.mainDeviceId === view.device.deviceId;
  const disabled = busy || operation?.busy === true;
  const content = <View style={[{ gap: 12 }, embedded && { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14 }]}>
    {embedded ? <SectionHeading title="空き時間の端末間同期" level="subsection" /> : null}
    <Text style={{ ...typography.caption, color: palette.muted }}>予定の時間帯だけを、本人の端末へ同期。</Text>
    {busy ? <ActivityIndicator color={palette.accent} /> : null}
    {view && !approved ? <>
      <Text style={{ ...typography.caption, color: palette.muted }}>{embedded ? '下の「端末間同期」で設定できます。' : '端末間同期の設定が必要です。'}</Text>
      {!embedded ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="端末間同期を設定" accessibilityLabel="本人端末の承認・メイン設定" compact disabled={disabled} onPress={onDevices} /> : null}
    </> : null}
    {approved && !main ? <>
      <Text style={typography.body}>設定済みの端末から受け取ります。</Text>
      {!view.pendingTargetDigest ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="更新" accessibilityLabel="メイン端末の時間帯を同期" compact disabled={disabled}
        onPress={() => run(async value => { showResult(await value.refreshData()); })} /> : null}
    </> : null}
    {view?.requiresSourceReview ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>Googleアカウントを確認して接続し直してください。</Text> : null}
    {main && !view.pendingTargetDigest ? <>
      <SettingsStatus>{view.connected ? '接続済み' : '未接続'}</SettingsStatus>
      {!view.connected || view.requiresSourceReview ? <>
        <SettingsAction placement={embedded ? 'panel' : 'page'} title="Googleと接続" accessibilityLabel="Googleアカウントを確認" compact disabled={disabled} onPress={() => run(async value => {
          const selected = await value.checkGoogleAccount(); if (alive.current) { setAccount(selected); setNeedsLogin(!selected); }
        })} />
        {needsLogin ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="Googleにログイン" accessibilityLabel="この端末でGoogleログインを確認" compact disabled={disabled} onPress={() => run(async value => {
          const selected = await value.restoreCurrentGoogleAccount(); if (alive.current) { setAccount(selected); setNeedsLogin(false); }
        })} /> : null}
        {account ? <><Text style={typography.label}>{account.label}</Text>
          <SettingsAction placement={embedded ? 'panel' : 'page'} title="このアカウントで接続" compact disabled={disabled} onPress={() => run(async value => {
            const result = await value.connectCurrentSource(account.subject, view.device.authorityDigest!);
            if (result.kind === 'review') { if (alive.current) setReview(result); return; } showResult(await value.refreshData());
          })} /></> : null}
      </> : <View style={{ flexDirection: 'row', gap: 10 }}>
        <SettingsAction placement={embedded ? 'panel' : 'page'} title="更新" accessibilityLabel="最新の時間帯を取得・同期" compact disabled={disabled}
          onPress={() => run(async value => { showResult(await value.refreshData()); })} />
        <SettingsAction intent="destructive" placement={embedded ? 'panel' : 'page'} title="接続解除" accessibilityLabel="Google Calendarの取得を停止" compact disabled={disabled} onPress={() => setStopReview(true)} />
      </View>}
    </> : null}
    {view?.pendingTargetDigest ? <View style={{ gap: 10 }}><SectionHeading title="接続変更の確認待ち" level="subsection" />
      <Text style={typography.caption}>端末に保存済み・受付の確認待ちです。</Text>
      <SettingsAction placement={embedded ? 'panel' : 'page'} title="再試行" accessibilityLabel="保存した変更の受付を確認・再開" compact disabled={disabled} onPress={() => run(async value => {
        const result = await value.resumeSource(); if (alive.current) { setReview(result.kind === 'review' ? result : null); setNotice(result.kind === 'review' ? '別の端末の変更を確認してください。' : '接続設定を確認しました。'); }
      })} />
      {review ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="現在の設定を使う" accessibilityLabel="確認した現在設定を採用して元の案を取り下げる" compact disabled={disabled} onPress={() => run(async value => {
        await value.dismissSource(review.targetDigest, review.observedCurrentDigest); if (alive.current) { setReview(null); setNotice('元の案を取り下げました。'); }
      })} /> : null}
    </View> : null}
    {stopReview ? <View style={{ gap: 10 }}><SectionHeading title="空き時間の同期を止めますか？" level="subsection" />
      <SettingsAction intent="destructive" placement={embedded ? 'panel' : 'page'} title="同期を止める" accessibilityLabel="確認して取得を停止" compact disabled={disabled} onPress={() => run(async value => {
        const result = await value.disableSource(view!.device.authorityDigest!); if (alive.current) { setStopReview(false); setAccount(null); setNotice(result.kind === 'ready' ? '時間帯の取得を停止しました。' : '接続変更の確認待ちです。'); }
      })} /><SettingsAction placement={embedded ? 'panel' : 'page'} title="キャンセル" accessibilityLabel="取得を続ける" compact disabled={disabled} onPress={() => setStopReview(false)} />
    </View> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={typography.caption}>{notice}</Text> : null}
    {error ? <><Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>接続を確認できませんでした。保存済みの内容は保持しています。</Text>
      {!view ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="再試行" accessibilityLabel="取得元の設定を再読込" compact disabled={disabled} onPress={() => run(async () => {})} /> : null}</> : null}
    {!view && !error ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="再読込" accessibilityLabel="取得元の設定を再読込" compact disabled={disabled} onPress={() => run(async () => {})} /> : null}
    {footer}
  </View>;
  return embedded ? content : <Page header={<SettingsHeader title="空き時間の端末間同期" onBack={onBack} />}>{content}</Page>;
}
