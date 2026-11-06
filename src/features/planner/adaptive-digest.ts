import { sharedDocumentDigest } from '../sharing/crypto.ts';

/** Private optional fields use their persisted JSON representation. Shared signed-payload validation stays strict. */
export function adaptivePersonalDigest(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, part: unknown) => {
    if (typeof part === 'number' && !Number.isFinite(part) || typeof part === 'function' || typeof part === 'symbol' || typeof part === 'bigint') throw new Error('個人予定の計算値を確認してください。');
    return part;
  });
  if (encoded === undefined) throw new Error('個人予定の計算値を確認してください。');
  return sharedDocumentDigest(JSON.parse(encoded));
}
