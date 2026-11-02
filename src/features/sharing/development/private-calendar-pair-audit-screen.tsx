import { useEffect, useRef, useState } from 'react';
import { Platform, Text } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';
import { AppButton, Card, palette, ScreenHeading, typography } from '../../../components/planner-ui';
import { V2FormScrollView } from '../v2-ui/form-controls';
import { createPrivateCalendarPairAuditContext } from '../../../platform/sharing/private-calendar-pair-audit';
import { auditPrivateCalendarPair, PRIVATE_CALENDAR_PAIR_QA_STEPS } from './private-calendar-pair-audit';
import type { PrivateCalendarPairAuditResult, PrivateCalendarPairQaStep } from './private-calendar-pair-audit';

const TITLES: Record<PrivateCalendarPairQaStep, string> = {
  reference: '検査用の本人端末情報を用意する', request: '確認情報から検査用の依頼を作る', approve: '検査端末の公開鍵を承認する', join: '承認と配布鍵を受け取る',
  main: '検査用のメイン端末を切り替える', publish: '合成した2万区間を暗号化して送る', receive: '別端末の暗号文を受信して照合する', revoke: '検査端末を解除して鍵を更新する', revoked: '解除後の鍵利用拒否を検査する',
};
export function PrivateCalendarPairAuditScreen(props: { host: unknown; port: unknown; step: unknown; reference?: unknown; request?: unknown; deviceId?: unknown }) {
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false); const [result, setResult] = useState<PrivateCalendarPairAuditResult | null>(null);
  const alive = useRef(false); const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const step = typeof props.step === 'string' && PRIVATE_CALENDAR_PAIR_QA_STEPS.includes(props.step as PrivateCalendarPairQaStep) ? props.step as PrivateCalendarPairQaStep : null;
  const run = async () => {
    if (!__DEV__ || !step || running.current) return; running.current = true; setBusy(true); setFailed(false); setResult(null);
    let context: Awaited<ReturnType<typeof createPrivateCalendarPairAuditContext>> | undefined;
    try {
      context = await createPrivateCalendarPairAuditContext(Platform.OS, props.host, props.port);
      const value = await auditPrivateCalendarPair(__DEV__, step, { reference: props.reference, request: props.request, deviceId: props.deviceId }, context);
      if (alive.current) setResult(value);
    } catch { if (alive.current) setFailed(true); }
    finally {
      try { await context?.close(); } catch { if (alive.current) { setResult(null); setFailed(true); } }
      finally { running.current = false; if (alive.current) setBusy(false); }
    }
  };
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'bottom']}><V2FormScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
    <ScreenHeading eyebrow="開発用・端末間検査" title="本人端末の承認と暗号化転送" />
    <Card><Text style={typography.body}>{__DEV__ ? '両実機の専用QA保存先とローカルEmulatorだけを使用します。実アカウントと既存QAは保持します。' : '開発ビルドだけで使用できます。'}</Text>
      {__DEV__ && step ? <AppButton title={TITLES[step]} disabled={busy} onPress={() => { void run(); }} /> : null}</Card>
    {busy ? <Text style={typography.body}>端末間の検査を実行中</Text> : null}
    {result ? <Card><Text style={typography.section} accessibilityRole="header">端末間検査 PASS：{result.step}</Text>
      <Text testID="pair-qa-device" style={typography.caption}>端末ID：{result.deviceId}</Text>
      <Text testID="pair-qa-root" style={typography.caption}>root照合値：{result.rootDigest}</Text>
      {result.authorityDigest ? <Text testID="pair-qa-authority" style={typography.caption}>認証照合値：{result.authorityDigest}</Text> : null}
      {result.mainDeviceId ? <Text testID="pair-qa-main" style={typography.caption}>メイン端末：{result.mainDeviceId}</Text> : null}
      {result.keyProof ? <Text testID="pair-qa-key" style={typography.caption}>鍵照合値：{result.keyProof}</Text> : null}
      {result.cacheProof ? <Text testID="pair-qa-cache" style={typography.caption}>cache照合値：{result.cacheProof}</Text> : null}
      {result.intervalCount ? <Text testID="pair-qa-count" style={typography.caption}>区間数：{result.intervalCount}・分割：{result.chunkCount}・連番：{result.sequence}</Text> : null}
      {result.restoredBeforeFetch ? <Text testID="pair-qa-restored" style={typography.caption}>通信前の復元：確認済み</Text> : null}
      {result.reference ? <Text testID="pair-qa-reference" style={typography.caption}>確認情報：{result.reference}</Text> : null}
      {result.request ? <Text testID="pair-qa-request" style={typography.caption}>確認依頼：{result.request}</Text> : null}
      {result.checks.map(check => <Text key={check} style={typography.caption}>{check}</Text>)}</Card> : null}
    {failed ? <Card><Text accessibilityRole="alert" style={typography.body}>端末間の検査に失敗しました。保存内容を保持して確認してください。</Text></Card> : null}
  </V2FormScrollView></SafeAreaView>;
}
