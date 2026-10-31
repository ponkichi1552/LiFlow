import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { AppButton, BackButton, Card, Page, ScreenHeading, typography } from '../../components/planner-ui';
import { createV2CompletionNoticePreview } from '../../platform/sharing/v2-completion-notice-preview';

export default function V2CompletionNoticePreviewRoute() {
  if (!__DEV__) return <Page><Card><Text style={typography.body}>開発ビルド専用です。</Text></Card></Page>;
  return <Preview />;
}
function Preview() {
  const router = useRouter(); const [qa] = useState(createV2CompletionNoticePreview); const running = useRef(false); const live = useRef(true);
  const [busy, setBusy] = useState(false); const [proof, setProof] = useState<string | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function run(step: 'present' | 'inspect' | 'clear') {
    if (running.current) return; running.current = true; setBusy(true); setProof(null);
    try { const result = await qa[step](); if (live.current) setProof(result); }
    catch { if (live.current) setProof('完了通知の配信検査は未完了です。端末の通知許可と表示を確認してください。'); }
    finally { running.current = false; if (live.current) setBusy(false); }
  }
  return <Page header={<BackButton disabled={busy} onPress={() => router.back()} />}><ScreenHeading title="開発用・完了通知のOS配信検査" />
    <Card><Text style={typography.caption}>合成1件を通常と同じOS配信経路で表示します。グループ同期・サーバー受付・背景実行の検査ではありません。実際の個人データ・Firebase・Googleは使いません。</Text>
      {([['present', '合成完了通知を表示'], ['inspect', '表示した完了通知を照合'], ['clear', '合成完了通知を片付ける']] as const).map(([step, title]) =>
        <AppButton key={step} title={title} variant="secondary" disabled={busy} onPress={() => { void run(step); }} />)}
      {proof ? <Text testID="v2-completion-notice-proof" style={typography.body}>{proof}</Text> : null}
    </Card></Page>;
}
