import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceDisplayStore } from '../src/features/sharing/v2-ui/workspace-display-store.ts';
import { v2CalendarDisplayRange } from '../src/features/sharing/v2-ui/calendar-range.ts';

const now = () => new Date('2026-10-31T10:00:00Z');
const model = () => ({ viewerUserId: 'owner', plan: { groupId: 'group', timeZone: 'Asia/Tokyo', range: { asOfDate: '2026-10-31' } } });
test('prepared workspace shares one read across all main tabs and rechecks access without recomputing on navigation', async () => {
  let reads = 0; let guards = 0; let permitted = true;
  const session = { readModel: async () => { reads++; return model(); } };
  const store = createWorkspaceDisplayStore(async () => { guards++; if (!permitted) throw new Error('revoked'); return session; }, now);
  const first = await store.read();
  for (const options of [undefined, { waste: true }, { management: true }, { management: true, appliances: true }]) assert.equal((await store.read(options)).model, first.model);
  assert.equal(reads, 1); assert.equal(guards, 5); assert.equal(store.peek({ management: true }).model, first.model);
  permitted = false; await assert.rejects(store.read(), /revoked/); assert.equal(reads, 1);
});
test('workspace cache coalesces concurrent reads and retries an invalidated in flight result instead of publishing stale state', async () => {
  let reads = 0; let release;
  const source = { readModel: async () => { reads++; if (reads === 1) await new Promise(resolve => release = resolve); return { ...model(), revision: reads }; } };
  const store = createWorkspaceDisplayStore(async () => source, now);
  const a = store.read(); const b = store.read({ management: true });
  for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
  store.invalidate(); release(); const [left, right] = await Promise.all([a, b]);
  assert.equal(reads, 2); assert.equal(left, right); assert.equal(left.model.revision, 2);
  left.session.invalidate(); await left.session.readModel(); assert.equal(reads, 3);
});
test('a slower access check reuses data already prepared by another page rather than repeating the scheduler', async () => {
  let reads = 0; let guards = 0; let release;
  const source = { readModel: async () => { reads++; return model(); } };
  const store = createWorkspaceDisplayStore(async () => { if (++guards === 2) await new Promise(resolve => release = resolve); return source; }, now);
  const first = store.read(); const second = store.read({ management: true });
  await first; release(); await second; assert.equal(reads, 1); assert.equal(guards, 2);
});
test('workspace display cache preserves loaded content on failure and cannot return or publish it after disposal', async () => {
  let failure = false; const source = { readModel: async () => { if (failure) throw new Error('offline'); return model(); } };
  const store = createWorkspaceDisplayStore(async () => source, now); const initial = await store.read();
  failure = true; store.invalidate(); await assert.rejects(store.read(), /offline/); assert.equal(store.peek().model, initial.model);
  failure = false; await store.read(); store.dispose(); assert.equal(store.peek(), undefined); await assert.rejects(store.read(), /変わりました/);
});
test('workspace display recomputes at the group midnight and keeps distinct settings authority reads', async () => {
  let date = now(); let reads = 0; const options = [];
  const store = createWorkspaceDisplayStore(async () => ({ readModel: async option => { reads++; options.push(option); return model(); } }), () => date);
  await store.read(); await store.read({ management: true, choreSettings: true }); assert.equal(reads, 2);
  assert.equal(options[1].management, true); assert.equal(options[1].calendarMonth, undefined);
  date = new Date('2026-10-31T15:00:00Z'); await store.read(); assert.equal(reads, 3);
});
test('shared calendar prepares adjacent months and retains bounded coverage while browsing back and forth', () => {
  const first = v2CalendarDisplayRange('2026-10-01');
  assert.ok(first.from <= '2026-09-01'); assert.ok(first.through >= '2026-11-30');
  const next = v2CalendarDisplayRange('2026-12-01', first); assert.ok(next.from <= first.from); assert.ok(next.through >= '2027-01-31');
  const distant = v2CalendarDisplayRange('2030-01-01', next); assert.ok(distant.from > next.through); assert.ok(distant.through < '2030-04-01');
});
test('prepared displays refresh at the personal midnight without waiting for the shared household midnight', async () => {
  let instant = now(); let reads = 0;
  const source = { readModel: async () => { reads++; return { ...model(), plan: { ...model().plan, timeZone: 'UTC' },
    privateOverlay: { status: 'ready', today: reads === 1 ? '2026-10-31' : '2026-11-01', timeZone: 'Asia/Tokyo' } }; } };
  const store = createWorkspaceDisplayStore(async () => source, () => instant);
  await store.read(); instant = new Date('2026-10-31T15:00:00Z'); await store.read(); assert.equal(reads, 2);
});

test('calendar month aliases and covered ranges reuse the same verified display across tabs without another plan calculation', async () => {
  let reads = 0; let permitted = true;
  const range = v2CalendarDisplayRange('2026-10-01');
  const source = { readModel: async () => { reads++; return { ...model(), plan: { ...model().plan, range: { ...range, asOfDate: '2026-10-31' } },
    waste: { range }, appliances: {}, privateOverlay: { status: 'ready', ownerUserId: 'owner', timeZone: 'Asia/Tokyo', today: '2026-10-31', range } }; } };
  const store = createWorkspaceDisplayStore(async () => { if (!permitted) throw new Error('revoked'); return source; }, now);
  const first = await store.read({ calendarMonth: 'current' });
  for (const options of [undefined, { management: true }, { waste: true }, { calendarMonth: '2026-10-01' }, { calendarMonth: '2026-10-01', calendarRange: range }]) {
    assert.equal(store.peek(options), first); assert.equal(await store.read(options), first);
  }
  assert.equal(reads, 1);
  await store.read({ management: true, choreSettings: true }); assert.equal(reads, 2, 'an editor takes its own authority read');
  store.invalidate(); await store.read({ calendarMonth: 'current' }); assert.equal(reads, 3, 'real input changes recalculate');
  permitted = false; await assert.rejects(store.read({ calendarMonth: '2026-10-01' }), /revoked/); assert.equal(reads, 3);
});

test('calendar cache never treats partial coverage, invalid ranges or another civil day as a complete prepared month', async () => {
  let reads = 0; let instant = now(); const range = { from: '2026-10-01', through: '2026-10-31' };
  const source = { readModel: async options => { reads++;
    if (options.calendarRange && !options.calendarMonth) throw new Error('invalid range');
    return { ...model(), plan: { ...model().plan, range: { ...range, asOfDate: '2026-10-31' } }, waste: { range }, appliances: {} };
  } };
  const store = createWorkspaceDisplayStore(async () => source, () => instant);
  await store.read(); await store.read({ calendarMonth: 'current' }); assert.equal(reads, 2, 'overview coverage cannot replace adjacent months');
  await assert.rejects(store.read({ calendarRange: range }), /invalid range/); assert.equal(reads, 3);
  instant = new Date('2026-10-31T15:00:00Z'); await store.read(); assert.equal(reads, 4);
});
