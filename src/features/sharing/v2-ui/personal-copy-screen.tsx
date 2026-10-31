import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { AppButton, BackButton, Card, Page, ScreenHeading, SectionHeading, typography } from '../../../components/planner-ui';
import { V2Choices, V2Flag } from './form-controls';
import type { V2PersonalCopyRuntime, V2PersonalCopyScreenState } from '../v2/personal-copy-runtime';
import type { JsonValue } from '../operations';

const labels: Record<string, string> = { name: '家事名', category: '分類', description: '説明', enabled: '有効状態',
  manufacturerRecommendedIntervalDays: 'メーカーの目安周期（日）', manufacturerRecommendedConditions: 'メーカーの実施条件',
  requiresCycleSelection: '周期の設定が必要', schedulingNotes: '周期について', load: '負荷', locationOrAppliance: '場所・家電',
  laundryDryingPreference: '洗濯物の干し方', instructions: '手順', procedureSections: '区分ごとの手順', tools: '道具', cautions: '注意点',
  trivia: '補足', sourceNotes: '参照元', estimatedMinutes: '目安時間（分）', applianceCareSource: '家電の確認元', applianceTaskName: 'お手入れ項目',
  title: '見出し', body: '内容', steps: '手順', manufacturer: 'メーカー', productName: '製品名', modelNumber: '型番', productUrl: '製品情報',
  manualUrl: '説明書', analyzedAt: '確認日時', evidence: '根拠', url: 'URL', pageOrSection: 'ページ・箇所' };
function valueText(value: JsonValue): string {
  if (value === null) return '未設定';
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  if (typeof value === 'string') return ({ light: '軽い', normal: '普通', heavy: '重い', indoors: '室内', outdoors: '屋外', either: 'どちらでも' } as Record<string, string>)[value] ?? (value || '（空欄）');
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length ? value.map(part => `・${valueText(part)}`).join('\n') : '（項目なし）';
  // A trivia ID is a stable internal reference; its title and full body are shown instead.
  return Object.entries(value).filter(([key]) => key !== 'id').map(([key, part]) => `${labels[key] ?? key}：${valueText(part)}`).join('\n');
}

export function V2PersonalCopyScreen({ load, onBack, notice }: { load(): Promise<V2PersonalCopyRuntime>; onBack(): void; notice?: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  return <CopyLoader key={attempt} load={load} onBack={onBack} notice={notice} retry={() => setAttempt(value => value + 1)} />;
}
function CopyLoader({ load, onBack, notice, retry }: { load(): Promise<V2PersonalCopyRuntime>; onBack(): void; notice?: ReactNode; retry(): void }) {
  const [loaded, setLoaded] = useState<{ runtime: V2PersonalCopyRuntime; initial: V2PersonalCopyScreenState } | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { let alive = true;
    void load().then(async runtime => { if (!alive) return; const initial = await runtime.load(); if (alive) setLoaded({ runtime, initial }); })
      .catch(() => { if (alive) setFailed(true); }); return () => { alive = false; };
  }, [load]);
  if (loaded) return <CopyForm {...loaded} onBack={onBack} notice={notice} />;
  return <Page header={<BackButton onPress={onBack} />}>{notice}<ScreenHeading title="個人設定から共有家事を追加" />
    {failed ? <Card><Text accessibilityRole="alert" style={typography.body}>コピー内容を読み込めませんでした。元の家事と確認内容は保持しています。</Text>
      <AppButton title="コピー内容を再読込" onPress={retry} /></Card> : <ActivityIndicator />}</Page>;
}
function CopyForm({ runtime, initial, onBack, notice }: { runtime: V2PersonalCopyRuntime; initial: V2PersonalCopyScreenState; onBack(): void; notice?: ReactNode }) {
  const [state, setState] = useState(initial); const [selected, setSelected] = useState<string[]>([]); const [preset, setPreset] = useState<'common' | 'eachMember'>('common');
  const [busy, setBusy] = useState(false); const running = useRef(false); const alive = useRef(true); const [error, setError] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function perform(work: () => Promise<unknown>) {
    if (running.current) return; running.current = true; setBusy(true); setError(false);
    try { await work(); const next = await runtime.load(); if (alive.current) { setState(next); setSelected([]); } }
    catch { if (alive.current) setError(true); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  const control = state.control; const review = control.review; const administrator = state.context?.administratorUserId === state.context?.userId && state.context !== null;
  return <Page header={<BackButton disabled={busy} onPress={onBack} />}>{notice}<ScreenHeading title="個人設定から共有家事を追加"
    description="選んだ家事を新しい共有家事として追加します。個人の家事・予定・過去の履歴はそのまま残ります。" />
    <Text style={typography.caption}>共有するのは、この後に確認する設定と説明だけです。過去の完了・Googleの対応情報・個人用の予定は共有しません。</Text>
    {review ? <>
      <Card><SectionHeading title={control.status === 'committed' ? '端末に追加済み' : '共有する内容を確認'} />
        {state.context ? <Text style={typography.body}>コピー先：{state.context.groupName}のメンバー</Text> : null}
        <Text style={typography.body}>{review.preset === 'common' ? '全員共通：誰か1人が行う家事' : '各人別：メンバーそれぞれが行う家事'}</Text>
        <Text style={typography.caption}>基準日：{review.anchorDate}。ここから共有予定を作ります。過去の実施日をコピーするものではありません。</Text>
        {control.status === 'committed' ? <Text accessibilityRole="alert" style={typography.body}>
          {control.synchronization === 'sent' ? '保管先への送信を確認しました。他メンバーの取得は各端末の同期後です。'
            : control.synchronization === 'needsReview' ? '端末に保存済みですが、権限の変更などにより共有前の確認が必要です。記録は保持しています。'
              : '端末に保存済み・送信待ちです。接続後のグループ同期で共有します。'}</Text> : null}
      </Card>
      {review.records.map(record => <Card key={record.sharedChoreId}><SectionHeading title={String(record.fields.name)} />
        <Text style={typography.body}>{record.configuration ? `周期：${record.configuration.intervalDays}日／実施期間：基準日の前${record.configuration.windowBeforeDays}日〜後${record.configuration.windowAfterDays}日` : '周期未設定：予定を作らず、無効な家事として追加します。'}</Text>
        {Object.entries(record.fields).filter(([key]) => key !== 'name' && key !== 'archived').map(([key, value]) => <View key={key} style={{ gap: 4 }}>
          <Text style={typography.label}>{labels[key]}</Text><Text style={typography.body}>{key === 'enabled' ? value ? '有効' : '無効' : valueText(value)}</Text>
        </View>)}
      </Card>)}
      {control.status === 'review' ? <Card><Text style={typography.body}>上の内容を、このグループ全員に共有します。追加後の削除・変更も共有操作になります。</Text>
        {!administrator ? <Text style={typography.caption}>有効状態と周期を含むコピーには、現在の管理者による確認が必要です。</Text> : null}
        <AppButton title="確認した設定を共有へ追加" disabled={busy || !administrator} onPress={() => { const reference = { id: review.id, digest: review.digest }; void perform(() => runtime.confirm(reference)); }} />
        <AppButton title="選び直す" variant="secondary" disabled={busy} onPress={() => { void perform(() => runtime.clear(control.revision)); }} />
      </Card> : <Card><Text style={typography.caption}>別の家事を選んでも、追加済みの共有家事と個人の家事は残ります。</Text>
        <AppButton title="別の家事を選ぶ" variant="secondary" disabled={busy} onPress={() => { void perform(() => runtime.clear(control.revision)); }} /></Card>}
    </> : administrator ? <>
      <Card><SectionHeading title="追加する家事を選択" /><Text style={typography.caption}>1〜20件選んでください。初めから選択されている家事はありません。</Text>
        {state.choices.map(choice => <V2Flag key={choice.id} label={choice.name} value={selected.includes(choice.id)}
          disabled={busy || selected.length >= 20 && !selected.includes(choice.id)} onChange={checked => setSelected(previous => checked ? [...new Set([...previous, choice.id])] : previous.filter(id => id !== choice.id))} />)}
        {!state.choices.length ? <Text style={typography.body}>追加できる個人家事がありません。</Text> : null}
      </Card>
      <Card><V2Choices label="実施する人" value={preset} onChange={setPreset} disabled={busy}
        choices={[{ value: 'common', label: '全員共通' }, { value: 'eachMember', label: '各人別' }]} />
        <Text style={typography.caption}>有効状態と、現在の個人設定に応じた周期・実施期間を引き継ぎます。説明や道具に私的な情報がないか、次の画面で確認してください。</Text>
        <AppButton title={`選んだ${selected.length}件を確認`} disabled={busy || selected.length === 0} onPress={() => { const ids = [...selected]; void perform(() => runtime.prepare(control.revision, ids, preset)); }} />
      </Card>
    </> : <Card><Text style={typography.body}>有効状態と周期を含む個人設定のコピーは、共有グループの管理者が行います。</Text></Card>}
    {error ? <Card><Text accessibilityRole="alert" style={typography.body}>操作を完了できませんでした。元の設定や参加者・権限が変わった可能性があります。保存内容を読み直し、必要なら選び直してください。</Text>
      <AppButton title="保存した内容を読み直す" variant="secondary" disabled={busy} onPress={() => { void perform(async () => {}); }} /></Card> : null}
  </Page>;
}
