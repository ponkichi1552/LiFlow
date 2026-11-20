import { File, Paths } from 'expo-file-system';

let previewSequence = 0;

/** The native viewer receives only verified local bytes. Keep the cache file alive while it is open. */
export async function showManualPdf(bytes: Uint8Array, digest: string, title: string, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return;
  // Preview resolves when the native viewer opens. Keep a recently handed-off file available for its reader.
  const cutoff = Date.now() - 24 * 60 * 60_000;
  try {
    for (const stored of Paths.cache.list()) if (stored instanceof File && /^liflow-manual-[a-f0-9]{64}(?:-\d+-\d+)?\.pdf$/u.test(stored.name)
      && stored.modificationTime !== null && stored.modificationTime < cutoff) stored.delete();
  } catch { /* A preview remains usable even if the system pruned one of its older files. */ }
  const file = new File(Paths.cache, `liflow-manual-${digest}-${Date.now()}-${++previewSequence}.pdf`);
  let presented = false;
  try {
    file.create({ overwrite: true });
    await file.write(bytes);
    if (!isCurrent()) return;
    if (!await file.canPreview({ mimeType: 'application/pdf' })) throw new Error('この端末でPDFを開けません。PDFを表示できるアプリを確認してください。');
    if (isCurrent()) { await file.preview({ mimeType: 'application/pdf', title }); presented = true; }
  } finally {
    if (!presented) try { if (file.exists) file.delete(); } catch { /* The normal cache sweep can finish cleanup. */ }
  }
}
