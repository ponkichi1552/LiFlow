import { ed25519 } from '@noble/curves/ed25519.js';

export type NativeEd25519Acceptance = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean;
// Larger snapshots keep the existing JS path instead of copying a large buffer across the native boundary.
const maximumNativeMessageBytes = 1024 * 1024;

export function createSharedEd25519Verifier(acceptNative?: NativeEd25519Acceptance): NativeEd25519Acceptance {
  return (signature, message, publicKey) => {
    // libsodium 1.0.22's default verifier requires canonical A and S, excludes small-order A,
    // and byte-compares R with the canonical encoding of [S]B - [k]A. These conditions imply
    // Noble's canonical decoding and cofactored equation with zip215:false. Its rejections
    // do not imply the same result, including for some signatures with torsion components.
    if (acceptNative && signature.length === 64 && publicKey.length === 32 && message.length <= maximumNativeMessageBytes) {
      try {
        if (acceptNative(signature, message, publicKey) === true) return true;
      } catch {
        // An unavailable native module must not block recovery or change verification.
        acceptNative = undefined;
      }
    }
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  };
}

export let verifySharedEd25519 = createSharedEd25519Verifier();

/** Only the native application entry point provides this version-pinned implementation. */
export function installNativeEd25519Acceptance(acceptNative: NativeEd25519Acceptance): void {
  verifySharedEd25519 = createSharedEd25519Verifier(acceptNative);
}
