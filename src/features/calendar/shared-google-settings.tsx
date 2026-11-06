import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, BackButton, Card, Page, ScreenHeading, palette, typography } from '../../components/planner-ui';
import { SettingsSwitch } from '../../components/settings-switch';
import type { SharedGoogleCalendarExport } from './shared-google-export';
import type { SharedCalendarExportControl } from '../../platform/storage/sharing-v2-calendar-export';

export function SharedGoogleCalendarSettings({ runtime, onBack }: { runtime: SharedGoogleCalendarExport; onBack: () => void }) {
  const [control, setControl] = useState<SharedCalendarExportControl | null>(null);
  const [review, setReview] = useState<Awaited<ReturnType<SharedGoogleCalendarExport['prepareConnection']>> | null>(null);
  const [busy, setBusy] = useState(false); const lock = useRef(false); const alive = useRef(true); const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    try { await work(); const next = await runtime.readControl(); if (alive.current) setControl(next); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Google接続を確認してください。'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true; void runtime.readControl().then(value => { if (alive.current) setControl(value); }).catch(() => { if (alive.current) setError('接続設定を読み込めませんでした。'); });
    return () => { alive.current = false; };
  }, [runtime]);
  const choose = (replaceAccount = false) => void run(async () => { const next = await runtime.prepareConnection({ replaceAccount }); if (alive.current) setReview(next); });
  return <Page header={<BackButton onPress={onBack} />}><ScreenHeading title="共有予定をGoogleにも表示" />
    <Card><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ ...typography.label, color: palette.ink, flex: 1 }}>共有予定をGoogleカレンダーに追加</Text>
      <SettingsSwitch accessibilityLabel="共有予定をGoogleカレンダーに追加" value={control?.enabled === true} disabled={busy || !control}
        onValueChange={enabled => enabled ? choose() : void run(async () => { await runtime.disable(control!.revision); setReview(null); })} />
    </View><Text style={{ ...typography.caption, color: palette.muted }}>初期状態はオフです。この端末で選んだGoogleカレンダーへ、グループ共通の予定を追加・更新します。Google側の変更はグループへ取り込みません。</Text>
    <Text style={{ ...typography.caption, color: palette.muted }}>オフにしても、Googleへ追加済みの予定は削除しません。再びオンにすると、同じ予定との紐付けを使って続けます。</Text>
    {control?.calendarId ? <Text style={{ ...typography.caption, color: palette.muted }}>{control.accountLabel} · {control.calendarLabel}</Text> : null}
    {control?.subject ? <AppButton title="接続先を変更" variant="quiet" compact disabled={busy} onPress={() => choose(true)} /> : null}
    </Card>
    {review ? <Card><Text style={{ ...typography.label, color: palette.ink }}>追加先を選択</Text><Text style={{ ...typography.caption, color: palette.muted }}>{review.account.label}</Text>
      {review.calendars.map(calendar => <AppButton key={calendar.id} title={calendar.summary || 'カレンダー'} variant="secondary" disabled={busy}
        onPress={() => void run(async () => { await runtime.connect(review, calendar.id); setReview(null); await runtime.synchronize({ force: true, interactive: true }); })} />)}
      {!review.calendars.length ? <Text style={{ ...typography.caption, color: palette.muted }}>書き込み可能なカレンダーがありません。</Text> : null}
      <AppButton title="キャンセル" variant="quiet" disabled={busy} onPress={() => setReview(null)} />
    </Card> : null}
    {error || control?.error ? <Text accessibilityRole="alert" style={{ ...typography.body, color: palette.warning }}>{error ?? control?.error}</Text> : null}
    {control?.enabled && control.pending ? <Text style={{ ...typography.caption, color: palette.muted }}>未確定または未送信の変更があります。</Text> : null}
    {control?.enabled ? <><Text style={{ ...typography.caption, color: palette.muted }}>最終同期：{control.lastSyncAt ? new Date(control.lastSyncAt).toLocaleString('ja-JP') : 'まだ同期していません'}</Text>
      <AppButton title="今すぐ追加・更新" disabled={busy} variant="secondary" onPress={() => void run(async () => { await runtime.synchronize({ force: true, interactive: true }); })} /></> : null}
  </Page>;
}
