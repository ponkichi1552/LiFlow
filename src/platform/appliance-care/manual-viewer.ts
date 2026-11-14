import { File, Paths } from 'expo-file-system';

/** The native viewer receives only verified local bytes. Keep the cache file alive while it is open. */
export async function showManualPdf(bytes: Uint8Array, digest: string, title: string, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return;
  const file = new File(Paths.cache, `liflow-manual-${digest}.pdf`);
  file.create({ overwrite: true });
  await file.write(bytes);
  if (!isCurrent()) return;
  if (!await file.canPreview({ mimeType: 'application/pdf' })) throw new Error('この端末でPDFを開けません。PDFを表示できるアプリを確認してください。');
  if (isCurrent()) await file.preview({ mimeType: 'application/pdf', title });
}
