import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { AppButton, BackButton, Card, Page, ScreenHeading, SectionHeading, typography } from '../../../components/planner-ui';
import type { V2GoogleTaskRuntime, V2GoogleConnectionReview } from '../v2/google-tasks-runtime';
import type { V2GoogleControl } from '../../../platform/storage/sharing-v2-google-tasks';
import type { GoogleSyncRunResult } from '../../google-sync/coordinator';

export type V2GoogleTaskUiRuntime = Pick<V2GoogleTaskRuntime, 'readControl' | 'reviewConnection' | 'connect' | 'pause' | 'synchronize'>;
export function V2GoogleTasksScreen({ load, onBack, notice }: { load(): Promise<V2GoogleTaskUiRuntime>; onBack(): void; notice?: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  return <Loader key={attempt} load={load} onBack={onBack} notice={notice} retry={() => setAttempt(value => value + 1)} />;
}
function Loader({ load, onBack, notice, retry }: { load(): Promise<V2GoogleTaskUiRuntime>; onBack(): void; notice?: ReactNode; retry(): void }) {
  const [value, setValue] = useState<{ runtime: V2GoogleTaskUiRuntime; control: V2GoogleControl } | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true; void load().then(async runtime => { if (!active) return; const control = await runtime.readControl(); if (active) setValue({ runtime, control }); })
      .catch(() => { if (active) setFailed(true); }); return () => { active = false; };
  }, [load]);
  if (value) return <Connection {...value} onBack={onBack} notice={notice} />;
  return <Page>{notice}<BackButton onPress={onBack} /><ScreenHeading title="共有家事とGoogle Tasks" />
    {failed ? <Card><Text accessibilityRole="alert" style={typography.body}>接続状態を読み込めませんでした。保存内容は保持しています。</Text>
      <AppButton title="Google連携を再読込" onPress={retry} /></Card> : <ActivityIndicator />}</Page>;
}
function resultMessage(result: GoogleSyncRunResult) {
  if (result.kind === 'success') return result.skipped ? '今回は同期を見送りました。接続状態と再試行時刻を確認してください。'
    : `同期しました。追加${result.created ?? 0}件・更新${result.updated ?? 0}件・完了と取消の取込${result.imported ?? 0}件。`;
  if (result.kind === 'retry') return '今回は反映が完了していません。送信待ちは保持し、次の同期で再試行します。';
  if (result.kind === 'authRequired') return '接続したGoogleアカウントと権限を確認してください。送信待ちは保持しています。';
  return '同期を完了できませんでした。保存内容を保持しています。接続を確認して再試行してください。';
}
function Connection({ runtime, control: initial, onBack, notice }: { runtime: V2GoogleTaskUiRuntime; control: V2GoogleControl; onBack(): void; notice?: ReactNode }) {
  const [control, setControl] = useState(initial); const [review, setReview] = useState<V2GoogleConnectionReview | null>(null);
  const [busy, setBusy] = useState<'review' | 'connect' | 'sync' | 'pause' | null>(null); const working = useRef<typeof busy>(null);
  const alive = useRef(true); const generation = useRef(0); const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { const epoch = generation; alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  async function perform(kind: NonNullable<typeof busy>, work: () => Promise<string>, allowDuringSync = false) {
    if (working.current && !(allowDuringSync && working.current === 'sync')) return;
    const version = ++generation.current; working.current = kind; setBusy(kind); setMessage(null);
    try {
      const result = await work(); const current = await runtime.readControl();
      if (alive.current && generation.current === version) { setControl(current); setMessage(result); }
    } catch { if (alive.current && generation.current === version) setMessage('操作を完了できませんでした。アカウント・接続状態を再確認してください。端末の保存内容は保持しています。'); }
    finally { if (generation.current === version) { working.current = null; if (alive.current) setBusy(null); } }
  }
  const state = control.state; const connected = state?.enabled === true && !state.disconnected;
  const when = (value?: string) => value ? new Date(value).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未実施';
  return <Page>{notice}<BackButton disabled={busy !== null && busy !== 'sync'} onPress={onBack} />
    <ScreenHeading title="共有家事とGoogle Tasks" description="共有家事を自分のGoogle Tasksへ同期します。個人の家事の連携設定は別に保存されます。" />
    <Card><SectionHeading title={connected ? '連携中' : state?.disconnected ? '接続を解除済み' : state ? '一時停止中' : '未接続'} />
      {control.label ? <Text style={typography.body}>{control.label}</Text> : null}
      <Text style={typography.caption}>本人の家事名・推奨日・完了状態を、確認したGoogleアカウントの専用リストへ送ります。グループへGoogleの識別子やトークンは共有しません。</Text>
      <Text style={typography.caption}>新しい家事は14日先まで、通信は100件以下ずつです。連携済みの家事は、予定日が先へ移動しても同じGoogleタスクを更新します。時刻の指定はLiFlowで確認してください。</Text>
      <Text style={typography.caption}>完了と取消は双方向に反映します。取消対象は本人が記録した完了だけです。別のメンバーの実施をGoogleから取り消すことはありません。</Text>
      {state ? <Text style={typography.caption}>最終同期：{when(state.lastSuccessfulSyncAt)}{state.status === 'retryPending' ? `／再試行：${when(state.nextRetryAt)}` : state.status === 'authRequired' ? '／アカウントの確認が必要' : state.status === 'error' ? '／同期エラー' : ''}</Text> : null}
      <AppButton title="Googleアカウントを確認" variant="secondary" disabled={busy !== null} onPress={() => { void perform('review', async () => {
        const selected = await runtime.reviewConnection(); if (alive.current) setReview(selected); return '表示したアカウントを確認して、連携を開始してください。';
      }); }} />
      {review ? <Card><Text style={typography.label}>{review.label}</Text><AppButton title="このアカウントで連携" disabled={busy !== null} onPress={() => { const selected = { ...review }; void perform('connect', async () => {
        await runtime.connect(selected); if (alive.current) setReview(null); return resultMessage(await runtime.synchronize({ force: true }));
      }); }} /></Card> : null}
      {state ? <AppButton title="共有家事を今すぐ同期" disabled={!connected || busy !== null} onPress={() => { void perform('sync', async () => resultMessage(await runtime.synchronize({ force: true }))); }} /> : null}
      {connected ? <AppButton title="Google連携を一時停止" variant="secondary" disabled={busy !== null && busy !== 'sync'} onPress={() => { void perform('pause', async () => {
        await runtime.pause(control.revision); return 'このグループのGoogle連携を一時停止しました。対応するタスクと履歴は保持しています。';
      }, true); }} /> : null}
      {state && !state.disconnected ? <AppButton title="このグループのGoogle接続を解除" variant="quiet" disabled={busy !== null && busy !== 'sync'} onPress={() => { void perform('pause', async () => {
        await runtime.pause(control.revision, true); return 'このグループの接続を解除しました。他の連携とGoogleタスク・履歴は保持しています。';
      }, true); }} /> : null}
    </Card>
    {message ? <Text accessibilityRole="alert" style={typography.body}>{message}</Text> : null}
  </Page>;
}
