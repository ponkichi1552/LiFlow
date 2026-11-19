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

export function ManualUploadInput({ onChange, onPickingChange, disabled = false, retained, filename }: {
  onChange(manual: UploadedManualInput | undefined, filename?: string): void;
  onPickingChange?(picking: boolean): boolean | void;
  disabled?: boolean;
  retained?: UploadedManualInput;
  filename?: string;
}) {
  const [pickedName, setPickedName] = useState<string>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const picking = useRef(false);
  const selectedName = filename ?? pickedName ?? (retained ? '保存済みの取扱説明書' : null);
  return <View style={{ gap: 8 }}>
    {selectedName ? <Text style={[typography.body, { color: palette.ink }]} numberOfLines={2}>{selectedName}</Text> : null}
    <AppButton variant="surface" title={busy ? 'PDFを読み込んでいます…' : selectedName ? 'PDFを変更' : '取扱説明書PDFを選ぶ'} disabled={disabled || busy}
      onPress={() => {
        if (picking.current || disabled || onPickingChange?.(true) === false) return;
        picking.current = true; setBusy(true); setError(null);
        void pickApplianceManual().then(value => { if (value) { setPickedName(value.name); onChange({ base64: value.base64, rightsConfirmed: true }, value.name); } })
          .catch(cause => setError(cause instanceof Error ? cause.message : 'PDFを読み込めませんでした。'))
          .finally(() => { picking.current = false; onPickingChange?.(false); setBusy(false); });
      }} />
    <Text style={[typography.caption, { color: palette.muted }]}>6MiB・100ページ以内</Text>
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
  </View>;
}
