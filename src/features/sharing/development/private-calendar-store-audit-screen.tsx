import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';
import { AppButton, Card, palette, ScreenHeading, typography } from '../../../components/planner-ui';
import { V2FormScrollView } from '../v2-ui/form-controls';
import { developmentPrivateCalendarCache, developmentPrivateCalendarSecrets } from '../../../platform/sharing/private-calendar-secrets';
import { nativePrivateCalendarCrypto } from '../../../platform/sharing/native-private-calendar-crypto';
import { auditPrivateCalendarStoredState, PRIVATE_CALENDAR_STORE_QA_USER_ID } from './private-calendar-store-audit';
import type { PrivateCalendarStoredAuditResult } from './private-calendar-store-audit';
import { auditPrivateCalendarCacheState } from './private-calendar-cache-audit';

export function PrivateCalendarStoreAuditScreen({ cacheAudit = false }: { cacheAudit?: boolean } = {}) {
  const [busy, setBusy] = useState(false); const [result, setResult] = useState<(PrivateCalendarStoredAuditResult & { sequence?: number; chunkCount?: number }) | null>(null); const [failed, setFailed] = useState(false);
  const label = cacheAudit ? '本人キャッシュ' : '本人保存';
  const alive = useRef(false); const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async () => {
    if (!__DEV__ || running.current) return; running.current = true; setBusy(true); setResult(null); setFailed(false);
    try {
      const options = { development: __DEV__, crypto: nativePrivateCalendarCrypto, store: developmentPrivateCalendarSecrets() };
      const value = cacheAudit ? await auditPrivateCalendarCacheState({ ...options, cache: developmentPrivateCalendarCache(PRIVATE_CALENDAR_STORE_QA_USER_ID) }) : await auditPrivateCalendarStoredState(options);
      if (alive.current) setResult(value);
    } catch { if (alive.current) setFailed(true); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'bottom']}><V2FormScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
    <ScreenHeading eyebrow={cacheAudit ? '開発用・本人キャッシュ検査' : '開発用・本人保存検査'} title={cacheAudit ? '暗号化キャッシュを検査' : '本人用の安全な保存を検査'} />
    <Card><Text style={typography.body}>{__DEV__ ? '検査専用の鍵とDBを使用します。アプリの終了・再起動前後で照合し、実アカウントの情報は読み書きしません。' : '開発ビルドだけで使用できます。'}</Text>
      {__DEV__ ? <AppButton title={busy ? `${label}を検査中` : `${label}を検査する`} disabled={busy} onPress={() => { void run(); }} /> : null}</Card>
    {result ? <Card><Text accessibilityRole="header" style={typography.section}>{label}の検査 PASS：{result.checks.length}件</Text>
      <Text style={typography.body}>{result.mode === 'created' ? '初回の検査用保存を作成' : '保存済みの検査用データを復元'}</Text>
      {result.sequence ? <Text testID="private-calendar-cache-sequence" style={typography.caption}>キャッシュ連番：{result.sequence}・分割：{result.chunkCount}</Text> : null}
      <Text testID="private-calendar-store-device" style={typography.caption}>端末ID：{result.deviceId}</Text>
      <Text testID="private-calendar-store-authority" style={typography.caption}>認証照合値：{result.authorityDigest}</Text>
      <Text testID="private-calendar-store-proof" style={typography.caption}>保存照合値：{result.storageProof}</Text>
      {result.checks.map((check) => <Text key={check} style={typography.caption}>{check}</Text>)}</Card> : null}
    {failed ? <Card><Text accessibilityRole="alert" style={typography.body}>保存の検査に失敗しました。自動再生成せず、保存先と実装を確認してください。</Text></Card> : null}
  </V2FormScrollView></SafeAreaView>;
}

export function PrivateCalendarCacheAuditScreen() { return <PrivateCalendarStoreAuditScreen cacheAudit />; }
