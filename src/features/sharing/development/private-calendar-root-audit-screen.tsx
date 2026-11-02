import { useEffect, useRef, useState } from 'react';
import { Platform, Text } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';
import { AppButton, Card, palette, ScreenHeading, typography } from '../../../components/planner-ui';
import { V2FormScrollView } from '../v2-ui/form-controls';
import { createPrivateCalendarRootAuditContext } from '../../../platform/sharing/private-calendar-root-audit';
import { auditPrivateCalendarRootSetup } from './private-calendar-root-audit';
import type { PrivateCalendarRootAuditResult } from './private-calendar-root-audit';

export function PrivateCalendarRootAuditScreen({ host, port }: { host: unknown; port: unknown }) {
  const [busy, setBusy] = useState(false); const [result, setResult] = useState<PrivateCalendarRootAuditResult | null>(null); const [failed, setFailed] = useState(false);
  const alive = useRef(false); const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async (action: 'prepare' | 'resume') => {
    if (!__DEV__ || running.current) return; running.current = true; setBusy(true); setResult(null); setFailed(false);
    let context: Awaited<ReturnType<typeof createPrivateCalendarRootAuditContext>> | undefined;
    try {
      context = await createPrivateCalendarRootAuditContext(Platform.OS, host, port);
      const value = await auditPrivateCalendarRootSetup(__DEV__, action, context);
      if (alive.current) setResult(value);
    } catch { if (alive.current) setFailed(true); }
    finally {
      try { await context?.close(); }
      catch { if (alive.current) { setResult(null); setFailed(true); } }
      finally { running.current = false; if (alive.current) setBusy(false); }
    }
  };
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'bottom']}><V2FormScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
    <ScreenHeading eyebrow="開発用・初回設定検査" title="通信中断からの復旧を検査" />
    <Card><Text style={typography.body}>{__DEV__ ? '合成した検査専用の鍵・DBとローカルEmulatorを使用します。準備後にアプリを終了し、再起動して続行します。実アカウントは読み書きしません。' : '開発ビルドだけで使用できます。'}</Text>
      {__DEV__ ? <><AppButton title="中断用の初回設定を準備する" disabled={busy} onPress={() => { void run('prepare'); }} /><AppButton title="保存した初回設定を再開する" disabled={busy} onPress={() => { void run('resume'); }} /></> : null}</Card>
    {busy ? <Text style={typography.body}>初回設定を検査中</Text> : null}
    {result ? <Card><Text accessibilityRole="header" style={typography.section}>{result.phase === 'prepared' ? `中断前の準備完了：${result.checks.length}件` : `初回設定の復旧 PASS：${result.checks.length}件`}</Text>
      <Text testID="private-calendar-root-device" style={typography.caption}>端末ID：{result.deviceId}</Text>
      <Text testID="private-calendar-root-digest" style={typography.caption}>準備照合値：{result.rootDigest}</Text>
      {result.keyProof ? <Text testID="private-calendar-root-key" style={typography.caption}>保存照合値：{result.keyProof}</Text> : null}
      {result.checks.map(check => <Text key={check} style={typography.caption}>{check}</Text>)}</Card> : null}
    {failed ? <Card><Text accessibilityRole="alert" style={typography.body}>初回設定の検査に失敗しました。保存内容を保持して原因を確認してください。</Text></Card> : null}
  </V2FormScrollView></SafeAreaView>;
}
