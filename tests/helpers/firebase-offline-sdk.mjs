import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import { FirebaseError } from '@firebase/util';
import { initializeFirestore, doc, runTransaction, disableNetwork, terminate } from '../../node_modules/@firebase/firestore/dist/index.rn.js';

const require = createRequire(import.meta.url);
const { patchAuthNetwork, target } = require('../../scripts/patch-firestore-auth-network.cjs');
const { readFileSync } = await import('node:fs');
const source = readFileSync(new URL(`../../node_modules/@firebase/firestore/${target}`, import.meta.url), 'utf8');
if (patchAuthNetwork(source) !== source) throw new Error('The native SDK fix was not installed.');

let attempts = 0;
const app = initializeApp({ projectId: 'demo-liflow-sdk-offline', apiKey: 'synthetic', appId: 'synthetic' }, 'offline-only-test');
// Test-only SDK boundary injection. No real account, successful token, service
// request, write, credential persistence or permissive production Rules.
const user = { uid: 'isolated-test', toKey: () => 'uid:isolated-test', isAuthenticated: () => true, isEqual: other => other?.uid === 'isolated-test' };
const credentials = {
  start(queue, changed) { queue.enqueueRetryable(() => changed(user)); },
  async getToken() { attempts++; throw new FirebaseError('auth/network-request-failed', 'synthetic offline credential fetch'); },
  invalidateToken() {}, shutdown() {},
};
const db = initializeFirestore(app, { credentials: { type: 'provider', client: credentials } });
const errors = [];
try {
  for (const maxAttempts of [2, 1]) {
    try { await runTransaction(db, async tx => (await tx.get(doc(db, 'isolated', 'never-requested'))).exists(), { maxAttempts }); }
    catch (error) { errors.push(error.code); }
  }
  // These public operations also use the SDK queue. A hard assertion would
  // poison it and leave this process stuck instead of completing normally.
  await disableNetwork(db); await terminate(db); await deleteApp(app);
  console.log(JSON.stringify({ attempts, errors, queueClosed: true }));
} catch (error) { console.error(error); process.exitCode = 1; }
