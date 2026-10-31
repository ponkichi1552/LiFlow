import { GoogleAuthProvider, OAuthProvider, onAuthStateChanged, signInWithCredential, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import * as AppleAuthentication from 'expo-apple-authentication';
import { digestStringAsync, CryptoDigestAlgorithm, getRandomBytesAsync } from 'expo-crypto';
import { Platform } from 'react-native';
import { authorizeGoogleSharingIdentity } from '../google-tasks/google-sign-in-gateway';
import { getSharingServices } from './firebase-services.ts';
import { loadOrCreateSharingDeviceIdentity, sharingSecureVault } from './secure-store.ts';

// Binding failure never blocks ordinary sharing. Paid AI still fails closed until the backend verifies the device.
async function bindPaidAiIdentity(uid: string) {
  if (!process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim()) return;
  try { const { bindApplianceAccount } = await import('../appliance-care/auth'); await bindApplianceAccount(uid); }
  catch { /* The AI screen shows unresolved bindings; no quota or identity is fabricated locally. */ }
}

let signingIn: Promise<User> | null = null;
let signingOut: Promise<void> | null = null;
function oneSignIn(operation: () => Promise<User>): Promise<User> {
  if (signingOut) return Promise.reject(new Error('ログアウトが終わってから再度ログインしてください。'));
  if (signingIn) return signingIn;
  const pending = operation(); signingIn = pending;
  void pending.finally(() => { if (signingIn === pending) signingIn = null; }).catch(() => undefined);
  return pending;
}

export function signInSharingWithGoogle(): Promise<User> {
  return oneSignIn(async () => {
    await sharingSecureVault.removeItem('active-workspace');
    const { idToken } = await authorizeGoogleSharingIdentity();
    const result = await signInWithCredential(getSharingServices().auth, GoogleAuthProvider.credential(idToken));
    await loadOrCreateSharingDeviceIdentity(result.user.uid);
    void bindPaidAiIdentity(result.user.uid);
    return result.user;
  });
}

export async function isSharingAppleSignInAvailable(): Promise<boolean> {
  return Platform.OS === 'ios' && process.env.EXPO_PUBLIC_APPLE_SHARING_ENABLED === 'true'
    && await AppleAuthentication.isAvailableAsync();
}

export function signInSharingWithApple(): Promise<User> {
  return oneSignIn(async () => {
    if (!await isSharingAppleSignInAvailable()) throw new Error('このビルドではAppleログインを利用できません。');
    await sharingSecureVault.removeItem('active-workspace');
    const random = await getRandomBytesAsync(32);
    const rawNonce = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const nonce = await digestStringAsync(CryptoDigestAlgorithm.SHA256, rawNonce);
    const apple = await AppleAuthentication.signInAsync({ nonce, requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME] });
    if (!apple.identityToken) throw new Error('Appleログインを完了できませんでした。');
    const credential = new OAuthProvider('apple.com').credential({ idToken: apple.identityToken, rawNonce });
    const result = await signInWithCredential(getSharingServices().auth, credential);
    await loadOrCreateSharingDeviceIdentity(result.user.uid);
    void bindPaidAiIdentity(result.user.uid);
    return result.user;
  });
}

export function signOutSharing(): Promise<void> {
  if (signingOut) return signingOut;
  // No Google revokeAccess/signOut and no deletion of personal SQLite data or device keys.
  const pending = (signingIn ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await sharingSecureVault.removeItem('active-workspace');
    return signOut(getSharingServices().auth);
  });
  signingOut = pending;
  void pending.finally(() => { if (signingOut === pending) signingOut = null; }).catch(() => undefined);
  return pending;
}

export function observeSharingUser(listener: (user: User | null) => void): () => void {
  return onAuthStateChanged(getSharingServices().auth, listener);
}
