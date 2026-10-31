import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { loadNativeModule } from './helpers/native-module.mjs';

function fixture(platform = 'android') {
  const events = []; let rejectCredential = false; let blockedIdentity;
  const user = { uid: 'firebase-uid' }; const auth = { name: 'isolated-sharing-auth' };
  class OAuthProvider { constructor(provider) { this.provider = provider; } credential(value) { return { provider: this.provider, ...value }; } }
  const module = loadNativeModule('src/platform/sharing/auth.ts', {
    'firebase/auth': { GoogleAuthProvider: { credential: (idToken) => ({ provider: 'google', idToken }) }, OAuthProvider,
      async signInWithCredential(target, credential) {
        assert.equal(target, auth); events.push(['credential', credential]); if (rejectCredential) throw new Error('synthetic auth failure'); return { user };
      }, async signOut(target) { assert.equal(target, auth); events.push(['firebase-sign-out']); },
      onAuthStateChanged(target, listener) { assert.equal(target, auth); listener(user); return () => events.push(['unsubscribe']); } },
    'expo-apple-authentication': { async isAvailableAsync() { return true; }, AppleAuthenticationScope: { FULL_NAME: 'name' },
      async signInAsync(options) { events.push(['apple', options]); return { identityToken: 'synthetic-apple-id-token' }; } },
    'expo-crypto': { async getRandomBytesAsync(n) { return new Uint8Array(n).fill(9); }, CryptoDigestAlgorithm: { SHA256: 'SHA256' },
      async digestStringAsync(_, value) { return createHash('sha256').update(value).digest('hex'); } },
    'react-native': { Platform: { OS: platform } },
    '../google-tasks/google-sign-in-gateway': { async authorizeGoogleSharingIdentity() {
      events.push(['native-basic-identity']); if (blockedIdentity) await blockedIdentity;
      return { idToken: 'synthetic-google-id-token', googleUserId: 'different-native-google-uid' };
    } },
    './firebase-services.ts': { getSharingServices: () => ({ auth }) },
    './secure-store.ts': { sharingSecureVault: { async removeItem(key) { assert.equal(key, 'active-workspace'); events.push(['clear-saved-home']); } },
      async loadOrCreateSharingDeviceIdentity(uid) { assert.equal(uid, user.uid); events.push(['protected-device-identity']); } },
  });
  return { module, events, user, fail: (value) => { rejectCredential = value; }, block: (value) => { blockedIdentity = value; } };
}

test('Google sharing sign-in uses only a basic ID token, binds the device key to the Firebase UID and coalesces duplicate taps', async () => {
  const h = fixture();
  const users = await Promise.all(Array.from({ length: 30 }, () => h.module.signInSharingWithGoogle()));
  assert.ok(users.every((user) => user === h.user));
  assert.deepEqual(h.events.map(([name]) => name), ['clear-saved-home', 'native-basic-identity', 'credential', 'protected-device-identity']);
});

test('a failed sharing authentication can be retried and sharing logout never revokes the existing Tasks session', async () => {
  const h = fixture(); h.fail(true); await assert.rejects(h.module.signInSharingWithGoogle(), /synthetic/);
  h.fail(false); await h.module.signInSharingWithGoogle(); await h.module.signOutSharing();
  assert.equal(h.events.filter(([name]) => name === 'firebase-sign-out').length, 1);
  assert.equal(h.events.filter(([name]) => name === 'protected-device-identity').length, 1);
});

test('sharing logout waits for an in-flight sign-in, rejects overlapping new logins and coalesces duplicate logout taps', async () => {
  const h = fixture(); let release; h.block(new Promise((resolve) => { release = resolve; }));
  const login = h.module.signInSharingWithGoogle(); const logout = h.module.signOutSharing();
  assert.equal(h.module.signOutSharing(), logout);
  await assert.rejects(h.module.signInSharingWithGoogle(), /ログアウト/);
  release(); await login; await logout;
  assert.equal(h.events.at(-1)[0], 'firebase-sign-out');
  assert.equal(h.events.at(-2)[0], 'clear-saved-home');
  assert.equal(h.events.filter(([name]) => name === 'firebase-sign-out').length, 1);
});

test('Apple sharing is conditional and uses a hashed native nonce with the original nonce supplied only to Firebase', async () => {
  const old = process.env.EXPO_PUBLIC_APPLE_SHARING_ENABLED;
  try {
    process.env.EXPO_PUBLIC_APPLE_SHARING_ENABLED = 'false'; const disabled = fixture('ios');
    assert.equal(await disabled.module.isSharingAppleSignInAvailable(), false);
    await assert.rejects(disabled.module.signInSharingWithApple(), /利用できません/);
    assert.equal(disabled.events.length, 0);
    process.env.EXPO_PUBLIC_APPLE_SHARING_ENABLED = 'true'; const h = fixture('ios');
    assert.equal(await h.module.isSharingAppleSignInAvailable(), true);
    await h.module.signInSharingWithApple();
    const nativeNonce = h.events.find(([name]) => name === 'apple')[1].nonce;
    const credential = h.events.find(([name]) => name === 'credential')[1];
    assert.equal(createHash('sha256').update(credential.rawNonce).digest('hex'), nativeNonce);
    assert.notEqual(credential.rawNonce, nativeNonce); assert.equal(credential.provider, 'apple.com');
    assert.equal(await fixture('android').module.isSharingAppleSignInAvailable(), false);
  } finally { if (old === undefined) delete process.env.EXPO_PUBLIC_APPLE_SHARING_ENABLED; else process.env.EXPO_PUBLIC_APPLE_SHARING_ENABLED = old; }
});

test('sharing auth observation is scoped to the sharing app and can unsubscribe', () => {
  const h = fixture(); let observed; const unsubscribe = h.module.observeSharingUser((user) => { observed = user; });
  assert.equal(observed, h.user); unsubscribe(); assert.deepEqual(h.events, [['unsubscribe']]);
});
