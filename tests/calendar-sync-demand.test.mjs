import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';

const flush = () => new Promise(setImmediate);
function fixture(t, platform) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  let events; let pending = false; let syncs = 0; let echo = false; let lastSyncAt = null;
  const effects = []; const app = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const runtime = { requestRange: async () => false, readControl: async () => ({ enabled: true, authRequired: false, lastSyncAt }),
    hasPendingWork: async () => pending,
    sync: async () => { syncs++; pending = false; lastSyncAt = new Date().toISOString(); if (echo) events('events'); return { kind: 'success' }; } };
  const module = loadNativeModule('src/features/calendar/use-personal-google-sync.tsx', {
    react: { useRef: value => ({ current: value }), useEffect: work => effects.push(work), useCallback: work => work },
    'react-native': { AppState: app, Platform: { OS: platform } },
    '../../platform/storage/calendar-events': { subscribeLocalCalendar: (_database, listener) => { events = listener; return () => {}; } },
    '../planner/initial-display-gate': { waitForInitialFrame: async () => {} },
    '../../platform/google-calendar/personal-runtime': { nativePersonalGoogleCalendar: () => runtime },
  });
  const request = module.usePersonalGoogleSync({}, async () => {}); const stop = effects[0]();
  return { request, stop, runtime, tick: async ms => { t.mock.timers.tick(ms); await flush(); }, syncs: () => syncs,
    echo: () => { echo = true; }, localEdit: () => { pending = true; events('events'); } };
}

const names = {
  ios: [
    'ios opening an already covered calendar requests fresh external changes without idle polling or rapid focus duplicates',
    'ios a received Calendar update never echoes another network scan while a real concurrent local edit still synchronizes',
    'ios a Calendar edit arriving during an in flight receive keeps its trailing send without an idle scan',
    'ios a failed external Calendar read retries even when there is no local edit to send',
  ],
  android: [
    'android opening an already covered calendar requests fresh external changes without idle polling or rapid focus duplicates',
    'android a received Calendar update never echoes another network scan while a real concurrent local edit still synchronizes',
    'android a Calendar edit arriving during an in flight receive keeps its trailing send without an idle scan',
    'android a failed external Calendar read retries even when there is no local edit to send',
  ],
};
for (const platform of ['ios', 'android']) {
  test(names[platform][0], async t => {
    const f = fixture(t, platform);
    try {
      await f.tick(400); assert.equal(f.syncs(), 1);
      await f.tick(600_000); assert.equal(f.syncs(), 1);
      f.request('2026-11-01', '2026-11-30', { refresh: true }); await flush(); await f.tick(400); assert.equal(f.syncs(), 2);
      for (let i = 0; i < 10; i++) f.request('2026-11-01', '2026-11-30', { refresh: true });
      await flush(); await f.tick(400); assert.equal(f.syncs(), 2);
    } finally { f.stop(); }
  });
  test(names[platform][1], async t => {
    const f = fixture(t, platform); f.echo();
    try {
      await f.tick(400); await f.tick(400); assert.equal(f.syncs(), 1, 'an inbound commit is already synchronized');
      f.localEdit(); await f.tick(400); assert.equal(f.syncs(), 2);
      await f.tick(400); assert.equal(f.syncs(), 2);
    } finally { f.stop(); }
  });
  test(names[platform][2], async t => {
    const f = fixture(t, platform); let release;
    const first = f.runtime.sync; let held = false; const gate = new Promise(resolve => { release = resolve; });
    f.runtime.sync = async () => { const value = await first(); if (!held) { held = true; await gate; } return value; };
    try {
      await f.tick(400); assert.equal(f.syncs(), 1); f.localEdit(); await f.tick(400);
      release(); await flush(); assert.equal(f.syncs(), 2);
      await f.tick(600_000); assert.equal(f.syncs(), 2);
    } finally { release(); f.stop(); }
  });
  test(names[platform][3], async t => {
    const f = fixture(t, platform); const original = f.runtime.sync; let attempts = 0;
    f.runtime.sync = async () => { if (++attempts === 1) throw new Error('synthetic offline read'); return original(); };
    try {
      await f.tick(400); assert.equal(attempts, 1); await f.tick(30_000); assert.equal(attempts, 2);
      await f.tick(600_000); assert.equal(attempts, 2);
    } finally { f.stop(); }
  });
}
