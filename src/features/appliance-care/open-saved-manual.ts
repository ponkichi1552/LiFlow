import { verifyManualContent } from './manual-document.ts';

/** Reads the retained original without submitting an analysis or trusting an external URL. */
export async function openSavedManual(input: {
  digest: string; read(digest: string): Promise<string | null>; isCurrent(): boolean;
  present(bytes: Uint8Array, digest: string, isCurrent: () => boolean): Promise<void>;
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(input.digest)) throw new Error('説明書の保存先を確認できません。');
  const content = await input.read(input.digest);
  if (!input.isCurrent()) return;
  if (!content) throw new Error('この端末に説明書PDFが保存されていません。');
  const verified = verifyManualContent(content, input.digest);
  if (input.isCurrent()) await input.present(verified.bytes, verified.sha256, input.isCurrent);
}
