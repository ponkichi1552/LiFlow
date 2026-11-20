interface Kdf {
  extract(salt: Uint8Array, input: Uint8Array): Uint8Array;
  expand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array;
}
export function deriveManualKemSecret(dh: Uint8Array, ephemeralPublic: Uint8Array, recipientPublic: Uint8Array, kdf: Kdf): Uint8Array;
export function deriveManualAead(secret: Uint8Array, info: Uint8Array, kdf: Kdf): { key: Uint8Array; nonce: Uint8Array };
