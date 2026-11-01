import { sharedDocumentDigest } from '../crypto.ts';

/** Keep existing small-history proofs byte-compatible; larger histories bind ordered, bounded pages. */
export function recoveryArrayContent(values: readonly unknown[]): unknown {
  if (values.length <= 4096) return values;
  if (values.length > 512_000) throw new Error('Recovery history exceeds snapshot capacity');
  const pages: string[] = [];
  for (let offset = 0; offset < values.length; offset += 1000) pages.push(sharedDocumentDigest(values.slice(offset, offset + 1000)));
  return { format: 'liflow-recovery-pages-v1', count: values.length, pageSize: 1000, pages };
}
export const recoveryArrayDigest = (values: readonly unknown[]) => sharedDocumentDigest(recoveryArrayContent(values));
