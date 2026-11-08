import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateFixture } from './helpers/sharing-v2-private-fixture.mjs';
import { projectV2PrivateTasks } from '../src/features/sharing/v2-ui/private-overlay.ts';
import { v2HomeUpcomingRows } from '../src/features/sharing/v2-ui/home-upcoming.ts';
import { homeUpcomingTasks } from '../src/features/planner/home-presentation.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const today = '2026-11-09', range = { from: '2026-11-10', through: '2026-11-15' };

async function input() {
  const f = await privateFixture();
  const { snapshot } = await repository.readPersonalPlannerOverlaySnapshot(f.database);
  const chore = snapshot.chores.find(item => item.id === f.chore.id);
  const entry = { id: 'same-occurrence', householdId: chore.householdId, choreId: chore.id, cycleBaseDate: '2026-11-11',
    suggestedDate: '2026-11-12', windowStart: '2026-11-12', windowEnd: '2026-11-14', assignedMemberIds: [], status: 'scheduled' };
  const completion = { id: 'one-real-completion', householdId: chore.householdId, choreId: chore.id, scheduleEntryId: entry.id,
    completedAt: '2026-11-09T01:00:00Z', completedLocalDate: today, completedTimeZone: 'Asia/Tokyo', outcome: 'completed', source: 'inApp',
    scheduledDate: '2026-11-11', scheduledWindowStart: '2026-11-10', scheduledWindowEnd: '2026-11-14' };
  return { f, chore, entry, completion, snapshot: { ...snapshot, today, chores: [chore], scheduleEntries: [entry], completions: [completion] } };
}

test('group home never repeats one personal completion on both its frozen recommendation and a recalculated day', async () => {
  const h = await input();
  try {
    const before = JSON.stringify(h.snapshot);
    const overlay = projectV2PrivateTasks({ ownerUserId: 'owner', snapshot: h.snapshot, today, timeZone: 'Asia/Tokyo' }, 'owner', { from: today, through: range.through });
    const model = { viewerUserId: 'owner', plan: { chores: [], history: [], range: { ...range, asOfDate: today } } };
    const rows = v2HomeUpcomingRows(model, { byDate: new Map() }, overlay, range, 'heavy');
    assert.deepEqual(rows.map(group => group.date), ['2026-11-11']);
    assert.equal(rows.flatMap(group => group.rows).length, 1);
    assert.equal(rows[0].rows[0].row.completed, true);
    assert.equal(JSON.stringify(h.snapshot), before);
  } finally { h.f.connection.close(); }
});

for (const platform of ['ios', 'android']) test(`${platform} home never repeats todays available occurrence in upcoming recommendations`, async () => {
  const h = await input();
  try {
    const entry = { ...h.entry, suggestedDate: '2026-11-11', windowStart: today };
    const snapshot = { ...h.snapshot, scheduleEntries: [entry], completions: [] };
    const screen = screenHarness('src/app/(tabs)/index.tsx', { platform, database: h.f.database, snapshot: () => snapshot });
    assert.equal(screen.nodes().filter(node => node.props.accessibilityRole === 'checkbox').length, 1);
    const overlay = projectV2PrivateTasks({ ownerUserId: 'owner', snapshot, today, timeZone: 'Asia/Tokyo' }, 'owner', { from: today, through: range.through });
    const model = { viewerUserId: 'owner', plan: { chores: [], history: [], range: { ...range, asOfDate: today } } };
    assert.equal(overlay.home.length, 1);
    assert.deepEqual(v2HomeUpcomingRows(model, { byDate: new Map() }, overlay, range, 'heavy'), []);
    const shared = { subject: { id: 'shared-current' }, date: '2026-11-11' };
    assert.deepEqual(v2HomeUpcomingRows(model, { byDate: new Map([[today, [shared]], ['2026-11-11', [shared]]]) }, undefined, range, 'heavy'), []);
    screen.unmount();
  } finally { h.f.connection.close(); }
});

test('personal home keeps a completed occurrence on its saved day and preserves separate later cycles with the same name', async () => {
  const h = await input();
  try {
    const next = { ...h.entry, id: 'next-occurrence', cycleBaseDate: '2026-11-15', suggestedDate: '2026-11-15', windowStart: '2026-11-15', windowEnd: '2026-11-15' };
    const result = homeUpcomingTasks([h.entry, next], [h.completion], range.from, range.through, [h.chore]);
    assert.deepEqual(result.map(row => [row.suggestedDate, row.completed]), [['2026-11-11', true], ['2026-11-15', false]]);
    assert.equal(new Set(result.map(row => row.id)).size, 2);
  } finally { h.f.connection.close(); }
});

test('personal home shows one row when a precompleted round and the next round share a recommendation without deleting either round', async () => {
  const h = await input();
  try {
    const next = { ...h.entry, id: 'real-next-round', cycleBaseDate: '2026-11-13', suggestedDate: '2026-11-11', windowStart: '2026-11-11', windowEnd: '2026-11-15' };
    const entries = [h.entry, next]; const records = [h.completion]; const before = JSON.stringify([entries, records]);
    const result = homeUpcomingTasks(entries, records, range.from, range.through, [h.chore]);
    assert.equal(result.length, 1); assert.equal(result[0].completion.id, h.completion.id);
    const undone = homeUpcomingTasks(entries, [{ ...h.completion, outcome: 'incomplete' }], range.from, range.through, [h.chore]);
    const onOriginalDay = undone.filter(row => row.suggestedDate === h.completion.scheduledDate);
    assert.equal(onOriginalDay.length, 1); assert.equal(onOriginalDay[0].entry.id, next.id); assert.equal(onOriginalDay[0].completed, false);
    assert.equal(JSON.stringify([entries, records]), before);
  } finally { h.f.connection.close(); }
});
