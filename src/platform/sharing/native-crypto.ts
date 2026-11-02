import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync, getRandomBytesAsync } from 'expo-crypto';
import type { SharingCryptoGateway } from '../../features/sharing/crypto.ts';

/** Cache callers validate encoded lengths first; authentication and tag size match the byte gateway. */
export async function decryptNativeBase64(key: Uint8Array, nonce: string, ciphertextWithTag: string, aad: Uint8Array): Promise<Uint8Array> {
  const nativeKey = await AESEncryptionKey.import(key);
  const sealed = AESSealedData.fromParts(nonce, ciphertextWithTag, 16);
  return aesDecryptAsync(sealed, nativeKey, { additionalData: aad, output: 'bytes' });
}

/** The asynchronous RNG has no development-mode Math.random fallback. */
export const nativeSharingCrypto: SharingCryptoGateway = {
  randomBytes: getRandomBytesAsync,
  async encrypt(key, nonce, plaintext, aad) {
    const nativeKey = await AESEncryptionKey.import(key);
    const sealed = await aesEncryptAsync(plaintext, nativeKey, { nonce: { bytes: nonce }, additionalData: aad, tagLength: 16 });
    return sealed.ciphertext({ includeTag: true });
  },
  async decrypt(key, nonce, ciphertextWithTag, aad) {
    const nativeKey = await AESEncryptionKey.import(key);
    const sealed = AESSealedData.fromParts(nonce, ciphertextWithTag, 16);
    return aesDecryptAsync(sealed, nativeKey, { additionalData: aad, output: 'bytes' });
  },
};
