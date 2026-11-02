import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';
import { AppButton, Card, palette, ScreenHeading, typography } from '../../../components/planner-ui';
import { V2FormScrollView } from '../v2-ui/form-controls';
import { nativePrivateCalendarCrypto } from '../../../platform/sharing/native-private-calendar-crypto';
import { auditPrivateCalendarNative } from './private-calendar-audit';
import type { PrivateCalendarAuditResult } from './private-calendar-audit';

export function PrivateCalendarAuditScreen() {
  const [busy, setBusy] = useState(false); const [result, setResult] = useState<PrivateCalendarAuditResult | null>(null);
  const [failed, setFailed] = useState(false); const alive = useRef(false); const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async () => {
    if (!__DEV__ || running.current) return; running.current = true; setBusy(true); setResult(null); setFailed(false);
    try { const value = await auditPrivateCalendarNative(nativePrivateCalendarCrypto, __DEV__); if (alive.current) setResult(value); }
    catch { if (alive.current) setFailed(true); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'bottom']}><V2FormScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
    <ScreenHeading eyebrow="開発用・本人Calendar検査" title="本人用Calendar暗号の検査" />
    <Card><Text style={typography.body}>{__DEV__ ? '独立した検査データをメモリ内で使用します。アカウント・端末の実データを読み書きせず、クラウドへ送信しません。' : '開発ビルドだけで使用できます。'}</Text>
      {__DEV__ ? <AppButton title={busy ? 'Native暗号を検査中' : 'Native暗号を検査する'} disabled={busy} onPress={() => { void run(); }} /> : null}</Card>
    {result ? <Card><Text accessibilityRole="header" style={typography.section}>本人用Calendar暗号 PASS：{result.checks.length}件</Text>
      <Text style={typography.body}>{result.intervalCount.toLocaleString()}区間・{result.chunkCount}分割</Text>
      <Text style={typography.caption}>合計 {result.elapsedMs}ms（準備 {result.timings.preparationMs}／暗号化 {result.timings.sealMs}／復号 {result.timings.openMs}／拒否検査 {result.timings.checksMs}）</Text>
      {result.checks.map((check) => <Text key={check} style={typography.caption}>{check}</Text>)}</Card> : null}
    {failed ? <Card><Text accessibilityRole="alert" style={typography.body}>検査に失敗しました。Nativeビルドと実装を確認してください。</Text></Card> : null}
  </V2FormScrollView></SafeAreaView>;
}
