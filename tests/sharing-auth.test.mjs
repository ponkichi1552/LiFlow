import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { loadNativeModule } from './helpers/native-module.mjs';

function fixture(platform = 'android') {
  const events = []; const identityOptions = []; let rejectCredential = false; let blockedIdentity; let rejectIdentity = false;
  const user = { uid: 'firebase-uid', providerData: [{ providerId: 'apple.com' }] }; const auth = { name: 'isolated-sharing-auth', currentUser: user, authStateReady: async () => {} };
  let credentialUser = user;
  let linkError;
  class OAuthProvider { constructor(provider) { this.provider = provider; } credential(value) { return { provider: this.provider, ...value }; } }
  const module = loadNativeModule('src/platform/sharing/auth.ts', {
    'firebase/auth': { GoogleAuthProvider: { credential: (idToken) => ({ provider: 'google', idToken }) }, OAuthProvider,
      async linkWithCredential(target, credential) {
        assert.equal(target, user); events.push(['link-provider', credential]); if (linkError) throw linkError;
        user.providerData.push({ providerId: 'google.com' }); return { user };
      },
      async signInWithCredential(target, credential) {
        assert.equal(target, auth); events.push(['credential', credential]); if (rejectCredential) throw new Error('synthetic auth failure'); auth.currentUser = credentialUser; return { user: credentialUser };
      }, async signOut(target) { assert.equal(target, auth); events.push(['firebase-sign-out']); },
      onAuthStateChanged(target, listener) { assert.equal(target, auth); listener(user); return () => events.push(['unsubscribe']); } },
    'expo-apple-authentication': { async isAvailableAsync() { return true; }, AppleAuthenticationScope: { FULL_NAME: 'name' },
      async signInAsync(options) { events.push(['apple', options]); return { identityToken: 'synthetic-apple-id-token' }; } },
    'expo-crypto': { async getRandomBytesAsync(n) { return new Uint8Array(n).fill(9); }, CryptoDigestAlgorithm: { SHA256: 'SHA256' },
      async digestStringAsync(_, value) { return createHash('sha256').update(value).digest('hex'); } },
    'react-native': { Platform: { OS: platform } },
    '../google-tasks/google-sign-in-gateway': { async authorizeGoogleSharingIdentity(options) {
      identityOptions.push(options);
      events.push(['native-basic-identity']); if (blockedIdentity) await blockedIdentity;
      if (rejectIdentity) throw new Error('synthetic account selection cancelled');
      return { idToken: 'synthetic-google-id-token', googleUserId: 'different-native-google-uid' };
    } },
    './firebase-services.ts': { getSharingServices: () => ({ auth }) },
    './workspaces.ts': { notifySharingWorkspaceChanged: () => {} },
    './secure-store.ts': { sharingSecureVault: {
      async setItem(key, value) { assert.equal(key, 'sharing-enabled'); assert.equal(value, 'true'); events.push(['enable-account-restore']); },
      async removeItem(key) { assert.equal(key, 'active-workspace'); events.push(['clear-saved-home']); } },
      async loadOrCreateSharingDeviceIdentity(uid) { assert.equal(uid, auth.currentUser.uid); events.push(['protected-device-identity', uid]); } },
  });
  return { module, events, user, auth, identityOptions, resultUser: value => { credentialUser = value; }, failIdentity: value => { rejectIdentity = value; }, fail: (value) => { rejectCredential = value; }, block: (value) => { blockedIdentity = value; }, linkError: value => { linkError = value; } };
}

test('explicit Google account switching selects an identity without signing out linking or deleting prior account state', async () => {
  const h = fixture('ios'); const selected = { uid: 'selected-firebase-uid', providerData: [{ providerId: 'google.com' }] }; h.resultUser(selected);
  assert.equal(await h.module.switchSharingGoogleAccount(), selected);
  assert.deepEqual(h.identityOptions, [{ selectAccount: true }]);
  assert.deepEqual(h.events.map(([name]) => name), ['native-basic-identity', 'credential', 'protected-device-identity', 'clear-saved-home', 'enable-account-restore']);
  assert.equal(h.events.find(([name]) => name === 'protected-device-identity')[1], selected.uid);
  assert.deepEqual(h.user.providerData, [{ providerId: 'apple.com' }], 'the old account must not be linked or merged');
});
test('explicitly selecting the same Google identity preserves the active workspace', async () => {
  const h = fixture('ios'); h.user.providerData.push({ providerId: 'google.com', uid: 'same-google' });
  assert.equal(await h.module.switchSharingGoogleAccount(), h.user);
  assert.equal(h.events.some(([name]) => name === 'clear-saved-home'), false);
  assert.equal(h.events.some(([name]) => name === 'firebase-sign-out'), false);
});
test('cancelled or rejected explicit account switching preserves the old workspace and a running login cannot consume the selection request', async () => {
  const h = fixture('ios'); h.failIdentity(true);
  await assert.rejects(h.module.switchSharingGoogleAccount(), /cancelled/);
  assert.equal(h.events.some(([name]) => name !== 'native-basic-identity'), false);
  h.events.length = 0; h.failIdentity(false); h.fail(true);
  await assert.rejects(h.module.switchSharingGoogleAccount(), /auth failure/);
  assert.deepEqual(h.events.map(([name]) => name), ['native-basic-identity', 'credential']);
  h.fail(false); let release; h.block(new Promise(resolve => { release = resolve; }));
  const login = h.module.signInSharingWithGoogle();
  try {
    await assert.rejects(h.module.switchSharingGoogleAccount(), /アカウント/);
    await assert.rejects(h.module.signInSharingWithGoogle({ selectAccount: true }), /アカウント/);
  }
  finally { release(); await login; }
});

test('Google sharing sign-in uses only a basic ID token, binds the device key to the Firebase UID and coalesces duplicate taps', async () => {
  const h = fixture();
  const users = await Promise.all(Array.from({ length: 30 }, () => h.module.signInSharingWithGoogle()));
  assert.ok(users.every((user) => user === h.user));
  assert.deepEqual(h.events.map(([name]) => name), ['clear-saved-home', 'native-basic-identity', 'credential', 'protected-device-identity', 'enable-account-restore']);
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
test('explicit Apple to Google linking retains one UID device keys group selection and subscription owner', async () => {
  const h = fixture('ios');
  assert.deepEqual(await h.module.sharingAccountProviders(h.user.uid), ['apple.com']);
  assert.equal(await h.module.linkSharingWithGoogle(), h.user);
  assert.deepEqual(h.events.map(([name]) => name), ['native-basic-identity', 'link-provider']);
  assert.deepEqual(await h.module.sharingAccountProviders(h.user.uid), ['apple.com', 'google.com']);
  await h.module.linkSharingWithGoogle(); assert.equal(h.events.length, 2, 'already linked accounts need no extra native authentication');
});
test('provider linking never merges another account and stops before Firebase if the current account changes', async () => {
  const h = fixture('ios'); h.linkError(Object.assign(new Error('synthetic'), { code: 'auth/credential-already-in-use' }));
  await assert.rejects(h.module.linkSharingWithGoogle(), /別のLiFlowアカウント/);
  assert.deepEqual(h.user.providerData, [{ providerId: 'apple.com' }]);
  assert.equal(h.events.some(([name]) => name === 'clear-saved-home' || name === 'firebase-sign-out' || name === 'credential'), false);
  let resolve; h.block(new Promise(done => { resolve = done; })); const pending = h.module.linkSharingWithGoogle(); await new Promise(setImmediate);
  h.auth.currentUser = { uid: 'someone-else' }; resolve(); await assert.rejects(pending, /切り替わり/);
  assert.equal(h.events.filter(([name]) => name === 'link-provider').length, 1);
});
