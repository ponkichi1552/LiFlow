import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

for (const platform of ['ios', 'android']) test(`${platform} appliance AI never becomes ready from login alone or a stale account binding response`, async () => {
  let observe; const effects = []; const ready = []; const pending = new Map(); let logins = 0;
  const screen = screenHarness('src/features/appliance-care/ai-account.tsx', { platform, exportName: 'ApplianceAiAccount', props: { onReady: value => ready.push(value) },
    effect: callback => effects.push(callback), mocks: {
      '../../platform/appliance-care/auth': { bindApplianceAccount: uid => new Promise((resolve, reject) => pending.set(uid, { resolve, reject })) },
      '../../platform/sharing/firebase-services': { isSharingConfigured: () => true },
      '../../platform/sharing/auth': { observeSharingUser: listener => { observe = listener; return () => {}; },
        isSharingAppleSignInAvailable: async () => false, signInSharingWithGoogle: async () => { logins++; }, signInSharingWithApple: async () => {} },
    } });
  const cleanup = effects[0]();
  try {
    assert.deepEqual(ready, [false]); await screen.press('Googleでログイン'); assert.equal(logins, 1);
    assert.equal(ready.at(-1), false, 'an identity login does not verify the physical app/device');
    observe({ uid: 'a', email: 'a@synthetic.example', isAnonymous: false }); await screen.flush();
    observe({ uid: 'b', email: 'b@synthetic.example', isAnonymous: false }); await screen.flush();
    pending.get('a').resolve({ remaining: 5 }); await screen.flush(); assert.equal(ready.at(-1), false);
    assert.equal(screen.text().includes('今月5回'), false);
    pending.get('b').reject(new Error('device continuity not verified')); await screen.flush();
    assert.equal(ready.at(-1), false); assert.match(screen.text(), /紐づけは未確認/u);
    observe({ uid: 'c', email: 'c@synthetic.example', isAnonymous: false }); await screen.flush();
    pending.get('c').resolve({ remaining: 2 }); await screen.flush();
    assert.equal(ready.at(-1), true); assert.match(screen.text(), /今月2回/u);
    observe(null); await screen.flush(); assert.equal(ready.at(-1), false);
  } finally { cleanup(); }
});
