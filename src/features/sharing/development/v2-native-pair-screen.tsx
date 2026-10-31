import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AppButton, BackButton, Card, Page, ScreenHeading, typography } from '../../../components/planner-ui';
import { V2GroupScreen } from '../v2-ui/group-screen';
import type { V2GroupScreenProps } from '../v2-ui/group-screen';
import { developmentV2NativePair } from '../../../platform/sharing/development-v2-native-pair';
import type { DevelopmentV2NativePair } from '../../../platform/sharing/development-v2-native-pair';
import { V2RecoveryPanel } from '../v2/recovery-panel';

const views = new Set<V2GroupScreenProps['view']>(['home', 'chores', 'details', 'configuration', 'round', 'date', 'history', 'calendar', 'requests', 'assignment', 'assignmentRequests', 'addChore', 'groupPolicy', 'dateRights', 'waste', 'appliances', 'appliance', 'applianceReview']);
export function V2NativePairRoute() {
  const params = useLocalSearchParams<{ host?: string; port?: string; run?: string; role?: string; view?: string; choreId?: string; occurrenceId?: string; subjectId?: string; anchorDate?: string; applianceId?: string }>();
  const router = useRouter(); const { host, port, run, role, view = 'audit' } = params;
  const load = useCallback(() => developmentV2NativePair(host, port, run, role), [host, port, run, role]);
  const loadSession = useCallback(async () => (await load()).ui(), [load]);
  const subscribe = useCallback((changed: () => void) => { let cleanup: (() => void) | undefined; let alive = true;
    void load().then(context => { if (alive) cleanup = context.subscribe(changed); }).catch(() => undefined);
    return () => { alive = false; cleanup?.(); };
  }, [load]);
  if (!__DEV__) return <Text>この画面は開発ビルド専用です。</Text>;
  if (view === 'audit') return <V2NativePairAudit load={load} onBack={() => router.back()} onOpen={() => navigate('home')}
    onEdit={() => navigate('details', { choreId: `development-v2-pair-${run}.builtin-chore-08` })} onRecovery={() => navigate('recovery')} />;
  if (view === 'recovery') return <V2NativeRecovery load={load} onBack={() => router.back()} />;
  if (!views.has(view as V2GroupScreenProps['view'])) return <Text>検査する画面を選んでください。</Text>;
  function navigate(next: string, extra: Record<string, string> = {}) {
    router.push({ pathname: '/development/v2-native-pair', params: { host, port, run, role, view: next, ...extra } });
  }
  return <V2GroupScreen purpose="workspace" workspaceName="開発用・Emulatorグループ" view={view as V2GroupScreenProps['view']} loadSession={loadSession} subscribe={subscribe}
    choreId={params.choreId} occurrenceId={params.occurrenceId} subjectId={params.subjectId} anchorDate={params.anchorDate} applianceId={params.applianceId}
    onBack={() => router.back()} onManage={() => navigate('audit')} onConfiguration={choreId => navigate('configuration', { choreId })}
    onDetails={choreId => navigate('details', { choreId })} onManageChores={() => navigate('chores')} onAddChore={() => navigate('addChore')}
    onChoreCreated={choreId => navigate('details', { choreId })} onHistory={() => navigate('history')} onCalendar={() => navigate('calendar')}
    onRound={(occurrenceId, subjectId, anchorDate) => navigate('round', { occurrenceId, subjectId, ...(anchorDate ? { anchorDate } : {}) })}
    onDate={(occurrenceId, subjectId) => navigate('date', { occurrenceId, subjectId, ...(params.anchorDate ? { anchorDate: params.anchorDate } : {}) })}
    onAssignment={(occurrenceId, subjectId) => navigate('assignment', { occurrenceId, subjectId, ...(params.anchorDate ? { anchorDate: params.anchorDate } : {}) })}
    onRequests={() => navigate('requests')} onAssignmentRequests={() => navigate('assignmentRequests')} onGroupPolicy={() => navigate('groupPolicy')}
    onDateRights={choreId => navigate('dateRights', { choreId })} onWaste={() => navigate('waste')} onAppliances={() => navigate('appliances')}
    onAppliance={applianceId => navigate('appliance', { applianceId })} onApplianceReview={applianceId => navigate('applianceReview', applianceId ? { applianceId } : {})} />;
}

function V2NativePairAudit({ load, onBack, onOpen, onEdit, onRecovery }: { load: () => Promise<DevelopmentV2NativePair>; onBack: () => void; onOpen: () => void; onEdit: () => void; onRecovery: () => void }) {
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [proof, setProof] = useState<Awaited<ReturnType<DevelopmentV2NativePair['proof']>> | null>(null);
  const [retained, setRetained] = useState<Awaited<ReturnType<DevelopmentV2NativePair['retainedProof']>> | null>(null);
  const alive = useRef(false); const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const perform = async (title: string, work: (context: DevelopmentV2NativePair) => Promise<unknown>) => {
    if (running.current) return; running.current = true; setBusy(true); setMessage('');
    try { await work(await load()); if (alive.current) setMessage(`${title} PASS`); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? `[${String(error.code)}] ` : '';
      if (alive.current) setMessage(`${code}${error instanceof Error ? error.message : '保存内容を保持して検査を再試行してください。'}`);
    }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  const action = (title: string, work: (context: DevelopmentV2NativePair) => Promise<unknown>) => <AppButton key={title} title={title} disabled={busy} variant="secondary" compact onPress={() => void perform(title, work)} />;
  const captureProof = async (context: DevelopmentV2NativePair) => { const value = await context.proof(); if (alive.current) setProof(value); };
  return <Page header={<BackButton onPress={onBack} />}><ScreenHeading eyebrow="開発用・異種OS総合検査" title="v2 同一グループ検査" />
    <Card><Text style={typography.caption}>ローカルEmulatorと合成UID・独立した鍵とDBだけを使用します。本番グループ・個人DB・Googleには接続しません。通常v2と同じSession・画面・暗号化送受信を使います。招待の種だけは公開の検査値です。</Text>
      <AppButton title="通常のv2画面を開く" disabled={busy} onPress={onOpen} />
      <AppButton title="検査対象の名前・手順を開く" disabled={busy} variant="quiet" compact onPress={onEdit} />
      <AppButton title="保存状態を照合" disabled={busy} variant="secondary" compact onPress={() => void perform('保存状態を照合', captureProof)} />
      {action('共有を今すぐ同期', context => context.synchronize())}
      {message ? <Text testID="v2-pair-result" accessibilityRole="alert" style={typography.caption}>{message}</Text> : null}
      {proof ? <View><Text testID="v2-pair-proof" style={typography.caption}>{JSON.stringify({ ...proof, chores: proof.chores.filter(chore => chore.enabled) })}</Text></View> : null}
    </Card>
    <Card>{action('所有者の作成を保存', context => context.prepareOwner())}
      {action('検査用の招待を作成', context => context.createInvitation())}
      {action('検査用の参加を申請', context => context.requestJoin())}
      {action('検査用の参加を承認', context => context.approve())}
      {action('共通と各人別の家事を準備', context => context.prepareChores())}</Card>
    <Card>{action('検査用の壊れた暗号文を送信', context => context.damageTransportForRecovery())}
      <AppButton title="所有者の復旧確認画面を開く" disabled={busy} variant="secondary" onPress={onRecovery} /></Card>
    <Card>{action('SDK通信を停止', context => context.network(false))}{action('SDK通信を再開', context => context.network(true))}
      <AppButton title="端末内の保持を確認" disabled={busy} variant="secondary" compact onPress={() => void perform('端末内の保持を確認', async context => {
        const value = await context.retainedProof(); if (alive.current) setRetained(value);
      })} />
      {retained ? <Text testID="v2-pair-retained" style={typography.caption}>{JSON.stringify(retained)}</Text> : null}
      {action('別UIDの読取拒否を確認', context => context.assertOutsiderDenied())}
      {action('参加解除後の取得拒否を確認', context => context.assertOwnReadDenied())}
      {action('検査用メンバーを除名', context => context.removeMember())}
      {action('検査接続を閉じる', context => context.dispose())}</Card>
  </Page>;
}

function V2NativeRecovery({ load, onBack }: { load: () => Promise<DevelopmentV2NativePair>; onBack: () => void }) {
  const [panel, setPanel] = useState<Awaited<ReturnType<DevelopmentV2NativePair['recoveryPanel']>> | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const running = useRef(false); const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void load().then(pair => pair.recoveryPanel()).then(value => { if (mounted.current) setPanel(value); })
      .catch(cause => { if (mounted.current) setError(cause instanceof Error ? cause.message : '検査グループを確認してください。'); });
    return () => { mounted.current = false; };
  }, [load]);
  const run = async (work: () => Promise<void>) => {
    if (running.current) return false; running.current = true; setBusy(true); setError('');
    try { await work(); return true; }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '検査を完了できませんでした。'); return false; }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  return <Page header={<BackButton onPress={onBack} />}><ScreenHeading title="開発用・所有者の復旧確認" />
    {panel ? <V2RecoveryPanel {...panel} busy={busy} run={run} initiallyExpanded /> : null}
    {error ? <Text accessibilityRole="alert" style={typography.body}>{error}</Text> : null}
  </Page>;
}
