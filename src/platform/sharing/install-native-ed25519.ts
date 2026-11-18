import { requireOptionalNativeModule } from 'expo';
import { installNativeEd25519Acceptance } from '../../features/sharing/ed25519-verifier.ts';
import type { NativeEd25519Acceptance } from '../../features/sharing/ed25519-verifier.ts';

interface NativeEd25519Module {
  version: string;
  verify: NativeEd25519Acceptance;
}

// Delay the JSI lookup until a signature actually needs verification.
let native: NativeEd25519Module | null | undefined;
installNativeEd25519Acceptance((signature, message, publicKey) => {
  if (native === undefined) {
    const candidate = requireOptionalNativeModule<NativeEd25519Module>('LiFlowEd25519');
    native = candidate?.version === '1.0.22' ? candidate : null;
  }
  return native?.verify(signature, message, publicKey) === true;
});
