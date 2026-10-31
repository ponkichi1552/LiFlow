import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import type { UploadedManualInput } from './api-contracts';

/** Only the copied cache file is deleted. The original chosen in Files/Drive remains untouched. */
export async function pickApplianceManual(): Promise<{ name: string; base64: string } | null> {
  const { getDocumentAsync } = await import('expo-document-picker');
  const { File, Paths } = await import('expo-file-system');
  const result = await getDocumentAsync({ type: 'application/pdf', multiple: false, copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0]; const file = new File(asset.uri);
  try {
    if (!Number.isSafeInteger(file.size) || file.size < 32 || file.size > 6 * 1024 * 1024) throw new Error('PDFは6MiB以内で選択してください。');
    return { name: asset.name, base64: await file.base64() };
  } finally {
    if (file.uri.startsWith(Paths.cache.uri.replace(/\/+$/u, '') + '/') && file.exists) file.delete();
  }
}

export function ManualUploadInput({ onChange, disabled = false }: { onChange: (manual: UploadedManualInput | undefined) => void; disabled?: boolean }) {
  const [picked, setPicked] = useState<{ name: string; base64: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const picking = useRef(false);
  return <View style={{ gap: 8 }}>
    <AppButton title={picked ? `PDFを変更：${picked.name}` : '取扱説明書PDFを選ぶ'} variant="secondary" disabled={disabled || busy}
      onPress={() => {
        if (picking.current) return; picking.current = true; setBusy(true); setError(null);
        void pickApplianceManual().then(value => { if (value) { setPicked(value); setConfirmed(false); onChange(undefined); } })
          .catch(cause => setError(cause instanceof Error ? cause.message : 'PDFを読み込めませんでした。'))
          .finally(() => { picking.current = false; setBusy(false); });
      }} />
    <Text style={[typography.caption, { color: palette.muted }]}>PDFは6MiB・100ページ以内。ご自身が解析に利用できる説明書を選んでください。PDFは解析APIへ送信され、グループには共有されません。</Text>
    {picked ? <AppButton compact variant="quiet" title={confirmed ? '✓ このPDFを解析APIへ送信することを確認済み' : 'このPDFを利用でき、解析APIへの送信を確認した'} disabled={disabled || busy}
      onPress={() => { const next = !confirmed; setConfirmed(next); onChange(next ? { base64: picked.base64, rightsConfirmed: true } : undefined); }} /> : null}
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
  </View>;
}
