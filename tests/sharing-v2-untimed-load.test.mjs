import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, anchorDate, date } from './helpers/sharing-v2-plan-fixture.mjs';
import { createPrivateCalendarReader } from '../src/features/sharing/v2/private-availability.ts';
import { buildV2PersonalPlan } from '../src/features/sharing/v2/personal-plan.ts';
import { privateFixture } from './helpers/sharing-v2-private-fixture.mjs';
import { projectV2PrivateTasks } from '../src/features/sharing/v2-ui/private-overlay.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
const { readPersonalPlannerOverlaySnapshot } = await import('../src/platform/storage/repository.ts');
const settings = { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 3 } };

test('date-only manual work stays on its assigned day without becoming a time conflict or asking for a time', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); f.designation(date(anchorDate));
  const plan = f.plan(); const before = JSON.stringify(plan);
  const personal = buildV2PersonalPlan(plan, { viewerUserId: 'a', settings, now: Date.parse('2026-10-27T01:00:00Z'),
    privateLoad: { ownerUserId: 'a', days: { [anchorDate]: { heavy: 0, normal: 3, total: 3 } } } });
  const fixed = personal.recommendations.find(row => row.state === 'manual');
  assert.ok(fixed); assert.equal(fixed.date, anchorDate); assert.notEqual(fixed.calendar.kind, 'conflict');
  assert.ok(!fixed.reasons.includes('calendarConflict')); assert.equal(JSON.stringify(plan), before);
  assert.notEqual(createPrivateCalendarReader(null, {}, 0)(date(anchorDate)).kind, 'conflict');
});

test('removing load alerts preserves automatic placement capacity and leaves the shared formal plan unchanged', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'], before: 0 }); f.make('chore', { load: 'heavy' }, { entityId: 'floor' });
  const plan = f.plan(); const before = JSON.stringify(plan);
  const base = { viewerUserId: 'a', settings, now: Date.parse('2026-10-27T01:00:00Z') };
  const free = buildV2PersonalPlan(plan, base);
  const busy = buildV2PersonalPlan(plan, { ...base, privateLoad: { ownerUserId: 'a', days: { [anchorDate]: { heavy: 1, normal: 0, total: 1 } } } });
  const first = free.recommendations.find(row => row.date === anchorDate); assert.ok(first);
  assert.notEqual(busy.recommendations.find(row => row.subjectOccurrenceId === first.subjectOccurrenceId).date, anchorDate);
  assert.equal(JSON.stringify(plan), before); assert.equal(busy.commonPlanHash, free.commonPlanHash);
});

test('private overdue work keeps its existing selector and completion semantics after load warnings are retired', async () => {
  const p = await privateFixture(); try {
    const { snapshot } = await readPersonalPlannerOverlaySnapshot(p.database);
    const chore = { ...snapshot.chores.find(row => row.id === p.chore.id), load: 'heavy' };
    const entry = { id: 'overdue-load', choreId: chore.id, householdId: chore.householdId, cycleBaseDate: addDays(anchorDate, -1),
      suggestedDate: addDays(anchorDate, -1), windowStart: addDays(anchorDate, -2), windowEnd: anchorDate, status: 'scheduled', assignedMemberIds: [] };
    const data = { ...snapshot, chores: [chore], scheduleEntries: [entry], completions: [] };
    const project = () => projectV2PrivateTasks({ ownerUserId: 'a', snapshot: data, today: anchorDate, timeZone: 'Asia/Tokyo' }, 'a', { from: addDays(anchorDate, -2), through: anchorDate });
    const pending = project(); assert.equal(pending.dailyLoad[anchorDate], undefined); assert.equal(pending.home.length, 1); assert.equal(pending.home[0].completed, false);
    data.completions = [{ id: 'done', householdId: chore.householdId, choreId: chore.id, scheduleEntryId: entry.id, scheduledDate: entry.suggestedDate,
      completedAt: '2026-10-27T01:00:00Z', completedLocalDate: anchorDate, outcome: 'completed' }];
    const completed = project(); assert.equal(completed.home.length, 1); assert.equal(completed.home[0].completed, true);
    assert.equal(completed.counts.get(anchorDate), 0); assert.equal(completed.dailyLoad[anchorDate], undefined);
  } finally { p.connection.close(); }
});
