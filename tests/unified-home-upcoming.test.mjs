import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { v2CalendarProjection } from '../src/features/sharing/v2-ui/calendar-projection.ts';
import { v2HomeUpcomingRows } from '../src/features/sharing/v2-ui/home-upcoming.ts';
import { homeUpcomingRange } from '../src/features/planner/home-presentation.ts';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
async function setup(t) {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close()); const initial = seeds();
  initial[2].payload.category = '居室'; await d.repository.commit(initial); let id = 0;
  const controller = createV2GroupController(d.repository, { makeId: () => `upcoming-${++id}`, now, sync: async () => {} });
  const shared = await controller.readModel(range); const calls = [];
  const privateRows = ['2026-10-29', '2026-11-04'].map((date, index) => ({ source: 'personal', key: `personal:future-${index}`, revision: 'stable', ownerUserId: 'owner', householdId: 'local-household', date, graceDays: 0,
    chore: { ...shared.plan.chores[0], id: `private-${index}`, householdId: 'local-household', name: `本人のみ${index}`, category: '居室', estimatedMinutes: 20, load: 'normal' }, completed: false, suggestedDate: date, windowStart: date, windowEnd: date }));
  const overlay = { status: 'ready', ownerUserId: 'owner', householdId: 'local-household', timeZone: 'Asia/Tokyo', today: range.asOfDate, setupCompleted: true,
    range, generatedThrough: range.through, home: [], byDate: new Map(privateRows.map(row => [row.date, [row]])), counts: new Map(), dailyLoad: {} };
  const session = createV2ScreenSession({ controller, groupId, userId: 'owner', now,
    readPreferences: () => ({ ownerUserId: 'owner', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }),
    privateTasks: { read: async () => overlay, setCompleted: async (...args) => { calls.push(args); return true; } } });
  return { d, session, calls, overlay };
}
test('joined upcoming lists each shared or personal occurrence once on its recommendation and rejects another owners overlay', async t => {
  const h = await setup(t); const model = await h.session.readModel(); const projection = v2CalendarProjection(model, model.personal);
  const rows = v2HomeUpcomingRows(model, projection, h.overlay, homeUpcomingRange(range.asOfDate, 'next'), 'heavy').flatMap(day => day.rows);
  assert.ok(rows.some(row => row.source === 'shared')); assert.ok(rows.some(row => row.source === 'personal'));
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
  const foreign = { ...h.overlay, ownerUserId: 'someone-else' };
  assert.throws(() => v2HomeUpcomingRows(model, projection, foreign, homeUpcomingRange(range.asOfDate, 'next'), 'heavy'), /本人/u);
  assert.deepEqual(homeUpcomingRange('2026-11-01', 'current'), { from: '2026-11-02', through: '2026-11-01' });
  assert.deepEqual(homeUpcomingRange('2026-11-01', 'next'), { from: '2026-11-02', through: '2026-11-08' });
});
for (const platform of ['ios', 'android']) test(`${platform} joined home exposes this and next week and sends a future private completion only to the private source`, async t => {
  const h = await setup(t); let focus; const opened = [];
  const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { platform, exportName: 'V2GroupScreen', focusEffect: callback => { focus = callback; }, props: {
    purpose: 'workspace', view: 'home', loadSession: async () => h.session, onBack() {}, onConfiguration() {}, onHistory() {}, onGuide: (...args) => opened.push(args),
  } });
  const stop = focus(); t.after(stop); for (let i = 0; i < 15; i++) await screen.flush();
  assert.equal(screen.button('今週').props.accessibilityState.selected, true); assert.ok(screen.text().includes('本人のみ0'));
  await screen.press('来週'); assert.equal(screen.button('来週').props.accessibilityState.selected, true); assert.ok(screen.text().includes('本人のみ1')); assert.equal(screen.text().includes('本人のみ0'), false);
  await screen.press('本人のみ1の説明を開く'); assert.deepEqual(opened, [['private-1', 'personal']]);
  const before = await listSharingOutbox(h.d.database, groupId); const check = screen.nodes().find(node => node.props.accessibilityLabel === '本人のみ1を完了');
  assert.ok(check); await check.props.onPress(); await screen.flush(); assert.deepEqual(h.calls, [['personal:future-1', 'stable', true]]);
  assert.deepEqual(await listSharingOutbox(h.d.database, groupId), before);
});
