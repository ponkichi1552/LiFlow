import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createAnalysisReceiptRecovery } from '../src/features/appliance-care/receipt-recovery.ts';
import { loadNativeModule } from './helpers/native-module.mjs';

const flush = () => new Promise(setImmediate);
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const state = { pending: false, sends: 0, watches: 0, failures: 0, allowed: true, local: null, account: null };
  const port = { hasPending: async () => state.pending, subscribe: changed => { state.local = changed; return () => { state.local = null; }; },
    watchAccount: changed => { state.watches++; state.account = changed; return () => { state.account = null; }; },
    flush: async () => { state.sends++; if (state.failures-- > 0) throw new Error('synthetic offline receipt');
      if (!state.allowed) return false; state.pending = false; return false; } };
  return { state, port, create: () => createAnalysisReceiptRecovery(port), tick: async value => { t.mock.timers.tick(value); await flush(); } };
}

test('an empty receipt outbox causes no authentication no send and no idle retry while a new durable receipt starts exactly one delivery', async t => {
  const h = fixture(t), recovery = h.create();
  try {
    recovery.resume(); await flush(); await h.tick(86400_000);
    assert.equal(h.state.watches, 0); assert.equal(h.state.sends, 0);
    h.state.pending = true; h.state.local(); await flush(); assert.equal(h.state.sends, 1);
    await h.tick(86400_000); assert.equal(h.state.sends, 1);
  } finally { recovery.stop(); }
});

test('a failed saved receipt retries with backoff stops in background and resumes without requiring another paid analysis', async t => {
  const h = fixture(t); h.state.pending = true; h.state.failures = 1; const recovery = h.create();
  try {
    recovery.resume(); await flush(); assert.equal(h.state.sends, 1);
    await h.tick(29_999); assert.equal(h.state.sends, 1); recovery.pause();
    await h.tick(86400_000); assert.equal(h.state.sends, 1);
    recovery.resume(); await flush(); assert.equal(h.state.sends, 2);
    await h.tick(86400_000); assert.equal(h.state.sends, 2);
  } finally { recovery.stop(); }
});

test('receipt recovery waits for an actual account change instead of polling a signed out or unrelated account', async t => {
  const h = fixture(t); h.state.pending = true; h.state.allowed = false; const recovery = h.create();
  try {
    recovery.resume(); await flush(); assert.equal(h.state.sends, 1);
    await h.tick(86400_000); assert.equal(h.state.sends, 1);
    h.state.allowed = true; h.state.account(); await flush(); assert.equal(h.state.sends, 2);
  } finally { recovery.stop(); }
});

test('late receipt database reads after backgrounding cannot start authentication or a send', async t => {
  const h = fixture(t); let release; h.port.hasPending = () => new Promise(resolve => { release = resolve; });
  const recovery = h.create();
  try { recovery.resume(); recovery.pause(); release(true); await flush(); assert.equal(h.state.watches, 0); assert.equal(h.state.sends, 0); }
  finally { recovery.stop(); }
});

test('receipt recovery honors a stored retry deadline and coalesces local notifications during one send', async t => {
  const h = fixture(t); h.state.pending = true; let calls = 0, release;
  h.port.flush = async () => { calls++; if (calls === 1) return { retryAt: Date.now() + 60_000 };
    await new Promise(resolve => { release = resolve; }); h.state.pending = false; return false; };
  const recovery = h.create();
  try {
    recovery.resume(); await flush(); await h.tick(59_999); assert.equal(calls, 1);
    await h.tick(1); assert.equal(calls, 2); for (let i = 0; i < 100; i++) h.state.local();
    release(); await flush(); await h.tick(86400_000); assert.equal(calls, 2);
  } finally { release?.(); recovery.stop(); }
});

test('the mounted receipt bridge waits for personal startup and does not initialize account services for an empty outbox', async () => {
  let effect, appChanged, ready; let checks = 0, accounts = 0, sends = 0;
  const first = new Promise(resolve => { ready = resolve; }); const db = {}; const state = { currentState: 'active', addEventListener: (_event, callback) => { appChanged = callback; return { remove() {} }; } };
  const module = loadNativeModule('src/features/appliance-care/analysis-receipt-bridge.tsx', {
    react: { useEffect: callback => { effect = callback; } }, 'react-native': { AppState: state }, 'expo-sqlite': { useSQLiteContext: () => db },
    '../../hooks/use-planner-data': { usePlannerData: options => { assert.deepEqual(options, { personal: true }); return { waitForInitialRead: () => first }; } },
    '../planner/initial-display-gate': { waitForInitialFrame: async () => {} },
    '../../platform/storage/analysis-deliveries': { deviceAnalysisDeliveries: value => { assert.equal(value, db); return { hasPending: async () => { checks++; return false; }, subscribe: () => () => {} }; } },
    '../../platform/appliance-care/receipt-recovery': { recoverNativeAnalysisReceipts: async () => { sends++; return false; } },
    '../../platform/sharing/auth': { observeSharingUser: () => { accounts++; return () => {}; } },
    '../../platform/sharing/firebase-services': { isSharingConfigured: () => { accounts++; return true; } },
    './receipt-recovery': { createAnalysisReceiptRecovery },
  });
  assert.equal(module.AnalysisReceiptBridge(), null); const stop = effect();
  try { await flush(); assert.equal(checks, 0); ready(); await flush(); assert.equal(checks, 1); assert.equal(accounts, 0); assert.equal(sends, 0);
    state.currentState = 'background'; appChanged('background'); state.currentState = 'active'; appChanged('active'); await flush(); assert.equal(sends, 0); }
  finally { stop(); }
  assert.match(readFileSync(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8'), /<AnalysisReceiptBridge\s*\/>/u);
});

test('native receipt recovery never sends to a different account or configured host and respects an existing receipt retry deadline', async () => {
  const previous = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL; process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = 'https://synthetic-api.invalid';
  const a = { uid: 'synthetic-a' }, b = { uid: 'synthetic-b' }; let current = a, authenticated = 0, sent = 0, retryAt = Date.now() + 60_000;
  const module = loadNativeModule('src/platform/appliance-care/receipt-recovery.ts', {
    '../../features/appliance-care/api-client': { applianceCareApiBaseUrl: () => process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL,
      analysisReceiptRetryAt: () => retryAt, flushAnalysisReceipts: async () => { sent++; } },
    '../sharing/firebase-services': { isSharingConfigured: () => true, getSharingServices: () => ({ auth: { authStateReady: async () => {}, get currentUser() { return current; } } }) },
    './auth': { authorizeApplianceCareApi: async () => { authenticated++; current = b; return { userId: b.uid }; } },
  });
  const store = { pending: async () => [{ baseUrl: 'https://other.invalid' }] };
  try {
    assert.equal(await module.recoverNativeAnalysisReceipts(store), false); assert.equal(authenticated, 0);
    store.pending = async () => [{ baseUrl: process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL }];
    assert.deepEqual(await module.recoverNativeAnalysisReceipts(store), { retryAt }); assert.equal(authenticated, 0);
    retryAt = 0; assert.equal(await module.recoverNativeAnalysisReceipts(store), false); assert.equal(authenticated, 1); assert.equal(sent, 0);
  } finally { if (previous === undefined) delete process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL; else process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = previous; }
});
