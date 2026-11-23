import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import type { UploadedManualInput } from './api-contracts';

const maxManualBytes = 6 * 1024 * 1024;
const maxManualPages = 100;
const invalidFormat = 'PDF形式の取扱説明書を選んでください。';
class ManualSelectionError extends Error {}

/** Only the copied cache file is deleted. The original chosen in Files/Drive remains untouched. */
export async function pickApplianceManual(): Promise<{ name: string; base64: string } | null> {
  const { getDocumentAsync } = await import('expo-document-picker');
  const { File, FileMode, Paths } = await import('expo-file-system');
  const result = await getDocumentAsync({ type: 'application/pdf', multiple: false, copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const file = new File(asset.uri);
  try {
    const size = file.size;
    if (!Number.isSafeInteger(size) || size < 32) throw new ManualSelectionError(invalidFormat);
    if (size > maxManualBytes) throw new ManualSelectionError('PDFは6MiB以内で選んでください。');

    const handle = file.open(FileMode.ReadOnly);
    try {
      const prefix = String.fromCharCode(...await handle.readBytes(8));
      if (!/^%PDF-\d\.\d$/u.test(prefix)) throw new ManualSelectionError(invalidFormat);
      const tailBytes = Math.min(1024, size);
      handle.offset = size - tailBytes;
      const tail = String.fromCharCode(...await handle.readBytes(tailBytes));
      if (!tail.includes('%%EOF')) throw new ManualSelectionError(invalidFormat);
    } finally {
      handle.close();
    }

    const { requireOptionalNativeModule } = await import('expo');
    const inspection = requireOptionalNativeModule<{ pageCount(uri: string): Promise<number | null> }>('LiFlowPdfInspection');
    if (inspection) {
      const pages = await inspection.pageCount(file.uri).catch(() => null);
      if (pages === null) throw new ManualSelectionError('PDFを確認できませんでした。もう一度選んでください。');
      if (!Number.isInteger(pages) || pages < 1) throw new ManualSelectionError('PDFを開けません。パスワードなしで開けるPDFを選んでください。');
      if (pages > maxManualPages) throw new ManualSelectionError('PDFは100ページ以内で選んでください。');
    }

    return { name: asset.name, base64: await file.base64() };
  } finally {
    if (file.uri.startsWith(Paths.cache.uri.replace(/\/+$/u, '') + '/') && file.exists) file.delete();
  }
}

export function ManualUploadInput({ onChange, onPickingChange, disabled = false, retained, selected, filename, needsReplacement = false, analysisError }: {
  onChange(manual: UploadedManualInput | undefined, filename?: string): void;
  onPickingChange?(picking: boolean): boolean | void;
  disabled?: boolean;
  retained?: boolean;
  selected?: boolean;
  filename?: string;
  needsReplacement?: boolean;
  analysisError?: string;
}) {
  const [pickedName, setPickedName] = useState<string>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const picking = useRef(false);
  const selectedName = filename ?? pickedName ?? (retained ? '保存済みの取扱説明書' : selected ? '選択したPDF' : null);
  const failure = error ?? analysisError;
  return <View style={{ gap: 8 }}>
    {selectedName ? <Text style={[typography.body, { color: palette.ink }]} numberOfLines={2}>{selectedName}</Text> : null}
    {failure ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{failure}</Text> : null}
    <AppButton variant={needsReplacement || !selectedName ? 'primary' : 'surface'} title={busy ? 'PDFを読み込んでいます…' : selectedName ? 'PDFを変更' : '取扱説明書PDFを選ぶ'} disabled={disabled || busy}
      onPress={() => {
        if (picking.current || disabled || onPickingChange?.(true) === false) return;
        picking.current = true; setBusy(true); setError(null);
        void pickApplianceManual().then(value => { if (value) { setPickedName(value.name); onChange({ base64: value.base64, rightsConfirmed: true }, value.name); } })
          .catch(cause => setError(cause instanceof ManualSelectionError ? cause.message : 'PDFを読み込めませんでした。もう一度選んでください。'))
          .finally(() => { picking.current = false; onPickingChange?.(false); setBusy(false); });
      }} />
    {!selectedName || failure ? <Text style={[typography.caption, { color: palette.muted }]}>6MiB・100ページ以内</Text> : null}
  </View>;
}
