import assert from 'node:assert/strict';
import test from 'node:test';
import { observePrivateCalendarForeground } from '../src/features/sharing/private-calendar/foreground-observer.ts';
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
function fixture() {
  const state = { configured: true, owner: true, now: 0, watches: 0, stops: 0, syncs: 0, ready: 0, local: null, configuration: null, change: null, error: null };
  const port = { assertOwner: () => { assert.equal(state.owner, true, 'owner changed'); }, configured: async () => state.configured, now: () => state.now,
    subscribeLocal: listener => { state.local = listener; return () => { state.local = null; }; },
    subscribeConfiguration: listener => { state.configuration = listener; return () => { state.configuration = null; }; },
    watchRemote: (changed, failed) => { state.watches++; state.change = changed; state.error = failed; return () => { state.stops++; }; },
    synchronize: async () => { state.syncs++; }, onReady: () => { state.ready++; } };
  return { state, port, start: () => observePrivateCalendarForeground(port) };
}
test('private Calendar foreground observer installs one owner listener without timers and ignores its own local invalidations', async () => {
  const f = fixture(); const stop = f.start(); await flush(); assert.equal(f.state.watches, 1); assert.equal(f.state.syncs, 1); assert.equal(f.state.ready, 1);
  for (let i = 0; i < 100; i++) f.state.local(); await flush(); assert.equal(f.state.watches, 1); assert.equal(f.state.syncs, 1);
  f.state.configuration(); await flush(); assert.equal(f.state.syncs, 2); stop(); assert.equal(f.state.local, null); assert.equal(f.state.configuration, null); assert.equal(f.state.stops, 1);
});
test('private Calendar foreground observer waits for explicit local trust and retains a configuration notification received during the first read', async () => {
  const f = fixture(); f.state.configured = false; let release; const gate = new Promise(done => { release = done; }); let first = true;
  f.port.configured = async () => { if (first) { first = false; await gate; return false; } return f.state.configured; };
  const stop = f.start(); await flush(); assert.equal(f.state.watches, 0); assert.equal(f.state.syncs, 0);
  f.state.configured = true; f.state.local(); release(); await flush(); assert.equal(f.state.watches, 1); assert.equal(f.state.syncs, 1); stop();
});
test('private Calendar foreground observer coalesces remote bursts and performs one trailing recovery without overlapping synchronizations', async () => {
  const f = fixture(); let release; let enter; let active = 0; let maximum = 0;
  const gate = new Promise(done => { release = done; }); const entered = new Promise(done => { enter = done; });
  f.port.synchronize = async () => { f.state.syncs++; active++; maximum = Math.max(maximum, active); if (f.state.syncs === 1) { enter(); await gate; } active--; };
  const stop = f.start(); await entered; for (let i = 0; i < 100; i++) f.state.change(); release(); await flush();
  assert.equal(f.state.syncs, 2); assert.equal(maximum, 1); assert.equal(f.state.watches, 1); stop();
});
test('private Calendar foreground observer detaches failed listeners and retries from periodic local activity only after the cooldown', async () => {
  const f = fixture(); const stop = f.start(); await flush(); f.state.error(); await flush();
  assert.equal(f.state.stops, 1); assert.equal(f.state.syncs, 2);
  for (let i = 0; i < 100; i++) f.state.local(); await flush(); assert.equal(f.state.watches, 1);
  f.state.now = 10 * 60_000; f.state.local(); await flush(); assert.equal(f.state.watches, 2); assert.equal(f.state.syncs, 3); stop(); assert.equal(f.state.stops, 2);
});
test('private Calendar foreground observer cannot attach a late listener or register work after disposal or an owner switch', async () => {
  for (const leave of ['dispose', 'owner']) {
    const f = fixture(); let release; const gate = new Promise(done => { release = done; }); f.port.configured = async () => { await gate; return true; };
    const stop = f.start(); await flush(); if (leave === 'dispose') stop(); else f.state.owner = false; release(); await flush();
    assert.equal(f.state.watches, 0); assert.equal(f.state.syncs, 0); assert.equal(f.state.ready, 0); stop();
  }
});
test('private Calendar foreground observer does not spin or retain an orphan subscription when a watcher reports failure synchronously', async () => {
  const f = fixture(); f.port.watchRemote = (_change, fail) => { f.state.watches++; fail(); return () => { f.state.stops++; }; };
  const stop = f.start(); await flush(); assert.equal(f.state.watches, 1); assert.equal(f.state.stops, 1); assert.equal(f.state.syncs, 1);
  f.state.local(); await flush(); assert.equal(f.state.watches, 1); stop();
});

test('audit100 private Calendar foreground recovery is not postponed for hours after the device clock moves backwards',async()=>{
 const f=fixture();f.state.now=10_000_000;const stop=f.start();try{await flush();f.state.error();await flush();const count=f.state.watches;f.state.local();await flush();assert.equal(f.state.watches,count,'a normal error still honors its cooldown');
 f.state.now-=3_600_000;f.state.local();await flush();assert.equal(f.state.watches,count+1);assert.equal(f.state.stops,1);
 }finally{stop();}
});
