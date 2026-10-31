import { SettingsSwitch as Switch } from '@/components/settings-switch';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { AppButton, BackButton, Card, Page, ScreenHeading, SectionHeading, typography } from '../../../components/planner-ui';
import { NumberInputField } from '../../../components/number-input-field';
import type { V2ReminderRuntime } from '../v2/reminder-runtime';
import type { V2ReminderControl } from '../../../platform/storage/sharing-v2-reminders';
import { createV2ReminderEditor } from './reminder-editor';
import { useV2DraftLifecycle } from './use-draft-lifecycle';
import type { ReactNode } from 'react';

export function V2ReminderScreen({ load, onBack, notice }: { load: () => Promise<V2ReminderRuntime>; onBack: () => void; notice?: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  return <ReminderLoader key={attempt} load={load} onBack={onBack} reload={() => setAttempt(value => value + 1)} notice={notice} />;
}
function ReminderLoader({ load, onBack, reload, notice }: { load: () => Promise<V2ReminderRuntime>; onBack: () => void; reload: () => void; notice?: ReactNode }) {
  const [value, setValue] = useState<{ runtime: V2ReminderRuntime; saved: V2ReminderControl } | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void load().then(async runtime => { if (!active) return; const saved = await runtime.store.read(); if (active) setValue({ runtime, saved }); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [load]);
  if (value) return <ReminderEditor {...value} onBack={onBack} notice={notice} />;
  return <Page header={<BackButton onPress={onBack} />}>{notice}<ScreenHeading title="このグループの通知" />
    {failed ? <Card><Text accessibilityRole="alert" style={typography.body}>通知設定を読み込めませんでした。保存内容は保持しています。</Text>
      <AppButton title="通知設定を再読込" onPress={reload} /></Card> : <ActivityIndicator />}</Page>;
}
function ReminderEditor({ runtime, saved, onBack, notice }: { runtime: V2ReminderRuntime; saved: V2ReminderControl; onBack: () => void; notice?: ReactNode }) {
  const [busy, setBusy] = useState(false); const working = useRef(false); const alive = useRef(true); const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const updateDelivery = useCallback(async () => {
    try {
      const permitted = await runtime.permissionStatus(); const result = await runtime.synchronize(); if (alive.current) setMessage(!permitted
        ? '端末に設定は保存済みですが、OSの通知許可がありません。通知を使う場合は端末の設定を確認してください。' : result.skippedDates.length
        ? '端末に保存済みです。地域の時刻が存在しない日は通知を省略します。' : 'この端末の通知へ反映しました。');
    } catch { if (alive.current) setMessage('端末に保存済みです。通知への反映は未完了のため、再試行してください。'); }
  }, [runtime]);
  const [store] = useState(() => createV2ReminderEditor({ store: runtime.store, saved }));
  // Finish delivery of an accepted preference even if navigation unmounts this editor; alive guards UI feedback.
  useLayoutEffect(() => { store.setAfterSave(() => { void updateDelivery(); }); }, [store, updateDelivery]);
  const { snapshot: state, navigateAfterSave } = useV2DraftLifecycle(store);
  async function toggle(enabled: boolean) {
    if (working.current) return; working.current = true; setBusy(true); setMessage(null);
    try {
      if (!await store.navigateAfterSave(() => {})) return;
      if (enabled && !await runtime.requestPermission()) { if (alive.current) setMessage('通知が許可されていません。端末の設定から許可してください。'); return; }
      if (!alive.current) return; store.resumeNavigation(); store.change({ enabled }); await store.flush();
    } catch { if (alive.current) setMessage('通知の許可を確認できませんでした。'); }
    finally { store.resumeNavigation(); working.current = false; if (alive.current) setBusy(false); }
  }
  const change = (patch: Parameters<typeof store.change>[0]) => { if (!working.current) store.change(patch); };
  return <Page keyboardAware header={<BackButton disabled={busy} onPress={() => { void navigateAfterSave(onBack); }} />}>{notice}
    <ScreenHeading title="このグループの通知" description="この端末と本人だけの設定です。他のメンバーの通知設定は変わりません。" />
    <Text style={typography.caption}>{state.status.phase === 'saving' ? 'この端末に保存中…' : state.hasDraft ? '未保存の入力があります。' : state.revision > 0 ? 'この端末に保存済み' : '通知はオフです。有効な入力は自動保存します。'}</Text>
    {state.validation ? <Text accessibilityRole="alert" style={typography.caption}>{state.validation}</Text> : null}
    {state.status.error ? <Card><Text accessibilityRole="alert" style={typography.caption}>{state.status.error}</Text>
      <AppButton title="通知設定の保存を再試行" disabled={busy} onPress={() => { void store.flush(); }} /></Card> : null}
    {state.navigationBlocked ? <Card><Text style={typography.body}>未保存の入力を修正するか、未保存の分を破棄して戻れます。</Text>
      <AppButton title="未保存の通知設定を破棄して戻る" variant="secondary" onPress={() => { store.discardDraft(); void navigateAfterSave(onBack); }} /></Card> : null}
    <Card><SectionHeading title="共有家事のお知らせ" />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><Text style={typography.label}>通知を受け取る</Text>
        <Switch accessibilityLabel="このグループの通知を受け取る" value={state.raw.enabled} disabled={busy} onValueChange={value => { void toggle(value); }} /></View>
      <Text style={typography.caption}>本人担当と担当未確定の共通家事を通知します。ほかの人だけの担当は催促しません。</Text>
      <Text style={typography.caption}>時刻未設定の家事は日ごとの負荷だけを確認し、上限以上で通知します。</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <NumberInputField accessibilityLabel="共有通知の時" suffix="時" value={state.raw.hour} maxLength={2} editable={!busy} onChangeText={hour => change({ hour })} onBlur={() => { void store.flush(); }} />
        <NumberInputField accessibilityLabel="共有通知の分" suffix="分" value={state.raw.minute} maxLength={2} editable={!busy} onChangeText={minute => change({ minute })} onBlur={() => { void store.flush(); }} />
      </View>
      <Text style={typography.caption}>グループの地域での時刻です。有効な入力は自動保存します。</Text>
      <Text style={typography.caption}>共通家事の完了は同期後に通知へ反映します。オフラインの端末には、次の同期まで通知が残る場合があります。OSの制限により、直近の予定を優先します。</Text>
      <AppButton title="通知を今すぐ更新" variant="secondary" disabled={busy} onPress={() => { void store.flush().then(ok => { if (ok) void updateDelivery(); }); }} />
    </Card>
    {message ? <Text accessibilityRole="alert" style={typography.caption}>{message}</Text> : null}
  </Page>;
}
