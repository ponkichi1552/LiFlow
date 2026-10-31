import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';

function fixture(signedIn = true) {
  const events = []; let token = 'synthetic-id-token'; let duringToken;
  const user = uid => ({ uid, async getIdToken() { events.push(['id-token', uid]); if (duringToken) await duringToken; return token; } });
  const shared = { currentUser: signedIn ? user('account-a') : null, async authStateReady() {} };
  const guest = { currentUser: null, async authStateReady() {} };
  const module = loadNativeModule('src/platform/appliance-care/auth.ts', {
    'firebase/app': { getApps: () => [], initializeApp: (_config, name) => { events.push(['app', name]); return { name }; } },
    'firebase/auth': { getReactNativePersistence: storage => storage, initializeAuth: app => { assert.equal(app.name, 'liflow-appliance-guest'); return guest; },
      getAuth: () => guest, async signInAnonymously(auth) { assert.equal(auth, guest); events.push(['anonymous-sign-in']); await Promise.resolve();
        guest.currentUser = user('guest-a'); return { user: guest.currentUser }; } },
    'expo-crypto': { randomUUID: () => 'synthetic-request-identifier' },
    '../sharing/firebase-services': { isSharingConfigured: () => true, getSharingServices: () => { events.push(['sharing-service']); return { auth: shared }; } },
    '../sharing/secure-store': { sharingSecureVault: { protectedStorage: true } },
  });
  return { ...module, events, shared, guest, token: value => { token = value; }, block: value => { duringToken = value; } };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} public appliance AI requires an existing nonanonymous account and never signs in a guest`, async () => {
    const previous = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL; process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = 'https://api.example.test';
    try {
      const f = fixture(false); assert.equal(f.events.length, 0);
      await assert.rejects(f.authorizeApplianceCareApi('https://api.example.test'), /ログインしてください/);
      assert.equal(f.events.some(item => item[0] === 'anonymous-sign-in' || item[0] === 'app'), false);
      f.shared.currentUser = { uid: 'anonymous', isAnonymous: true };
      await assert.rejects(f.authorizeApplianceCareApi('https://api.example.test'), /ログインしてください/);
      assert.equal(f.shared.currentUser.uid, 'anonymous', 'the API never changes account or joins a group');
    } finally { if (previous === undefined) delete process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL; else process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = previous; }
  });
}

test('public appliance API uses the existing account without extra OAuth grants and refuses a changed account before or during token refresh', async () => {
  const previous = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL; process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = 'https://api.example.test';
  try {
    const f = fixture(); const session = await f.authorizeApplianceCareApi('https://api.example.test');
    assert.equal(f.events.some(item => item[0] === 'anonymous-sign-in'), false);
    assert.equal((await session.headers()).authorization, 'Bearer synthetic-id-token');
    f.shared.currentUser = { uid: 'account-b' }; await assert.rejects(session.headers(), /切り替わりました/);
    const next = await f.authorizeApplianceCareApi('https://api.example.test');
    let release; f.shared.currentUser.getIdToken = async () => { await new Promise(resolve => { release = resolve; }); return 'stale'; };
    const pending = next.headers(); f.shared.currentUser = null; release();
    await assert.rejects(pending, /切り替わりました/);
  } finally { if (previous === undefined) delete process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL; else process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = previous; }
});

test('public appliance API never obtains or sends a token to HTTP credential-bearing or an unconfigured foreign host', async () => {
  const previous = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL; process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = 'https://api.example.test';
  try {
    const f = fixture();
    for (const url of ['http://api.example.test', 'https://api.example.test.attacker.example', 'https://private:secret@api.example.test', 'https://elsewhere.example']) {
      await assert.rejects(f.authorizeApplianceCareApi(url));
    }
    assert.equal(f.events.length, 0);
  } finally { if (previous === undefined) delete process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL; else process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = previous; }
});
