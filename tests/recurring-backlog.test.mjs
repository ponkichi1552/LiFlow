import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, date } from './helpers/sharing-v2-plan-fixture.mjs';
import { replayAdaptiveHistory } from '../src/domain/scheduling/adaptive/history.ts';
import { v2CalendarProjection } from '../src/features/sharing/v2-ui/calendar-projection.ts';
import { applyV2AutomaticBacklog } from '../src/features/sharing/v2/automatic-backlog.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { v2GoogleTaskItems } from '../src/features/sharing/v2/google-tasks-projection.ts';
import { buildV2PersonalPlan } from '../src/features/sharing/v2/personal-plan.ts';

const range = { from: '2026-09-25', through: '2026-10-15', asOfDate: '2026-10-01' };
const rows = plan => plan.occurrences.flatMap(round => round.subjects.map(subject => ({ round, subject })));
const pending = plan => rows(plan).filter(row => row.subject.automaticBacklog === 'pending');
const init = options => fixture({ cycle: 14, before: 1, after: 1, configuration: { anchorDate: '2026-09-01' }, ...options });
const complete = (f, day, at, subject = null) => f.complete({ actor: subject ?? 'owner', subject, day, performedAt: `${at}T01:00:00Z`,
  scheduledDate: day, scheduledWindowStart: addDays(day, -1), scheduledWindowEnd: addDays(day, 1),
  recordedCommonWindow: { start: addDays(day, -1), end: addDays(day, 1) } });

test('recurring backlog keeps the first unfinished automatic round beyond the read horizon and a late completion creates one real history record', async () => {
  const f = await init(); complete(f, '2026-09-01', '2026-09-01');
  let plan = f.plan(range);
  assert.deepEqual(f.state().assessment.rejected, []);
  assert.deepEqual(pending(plan).map(row => row.round.anchorDate), ['2026-09-15']);
  assert.equal(pending(plan)[0].subject.showExpiredOnHome, true);
  assert.equal(pending(plan)[0].subject.virtuallyConsumed, false, 'the real pending obligation must remain available to integrations');
  const work = complete(f, '2026-09-15', '2026-10-01'); plan = f.plan(range);
  assert.deepEqual(f.state().assessment.rejected, []);
  assert.equal(plan.history.filter(row => row.active).length, 2, 'the previous real completion plus this one; missed slots are not completed');
  const record = plan.history.find(row => row.operationId === work.operationId);
  assert.equal(record.anchorDate, '2026-09-15'); assert.equal(record.performedAt, '2026-10-01T01:00:00Z');
  assert.equal(record.schedule.windowEnd, '2026-09-16');
  const skipped = rows(plan).find(row => row.round.anchorDate === '2026-09-29');
  assert.equal(skipped.subject.automaticBacklog, 'covered'); assert.equal(skipped.subject.completed, false);
  assert.equal(f.plan(range, [...f.facts].reverse()).planHash, plan.planHash, 'reversed receipt order produces the same consolidated plan');
  assert.equal(v2CalendarProjection({ plan, viewerUserId: 'owner', adminUserId: 'owner' }).byDate.get('2026-10-01')?.length, 1,
    'only the actual completed round remains, even though its anchor was outside the loaded range');
  f.make('completion', { targetOperationId: work.operationId }, { actor: 'owner', entityId: work.entityId, operationType: 'undo' });
  plan = f.plan(range);
  assert.deepEqual(pending(plan).map(row => row.round.anchorDate), ['2026-09-15']);
  assert.equal(rows(plan).find(row => row.round.anchorDate === '2026-09-29').subject.automaticBacklog, 'later');
  assert.equal(plan.history.filter(row => row.active).length, 1);
});

test('the oldest overdue backlog completion and targeted Undo retain their Google identity and only completed work carries an actual completion instant', async () => {
  const f = await init(); complete(f, '2026-09-01', '2026-09-01');
  const project = () => {
    const plan = f.plan(range);
    const personal = buildV2PersonalPlan(plan, { viewerUserId: 'owner', now: Date.parse('2026-10-01T01:00:00Z'),
      settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } });
    return v2GoogleTaskItems(plan, 'owner', personal);
  };
  const initial = project().find(item => item.entry.cycleBaseDate === '2026-09-15'); assert.ok(initial);
  assert.equal(initial.synchronizationBlocked, undefined); assert.equal(initial.completedAt, undefined);
  const work = complete(f, '2026-09-15', '2026-10-01');
  const done = project(); const actual = done.find(item => item.entry.id === initial.entry.id);
  assert.equal(actual.completedAt, '2026-10-01T01:00:00Z');
  assert.equal(done.some(item => item.entry.cycleBaseDate === '2026-09-29'), false, 'covered automatic slots cannot create fake Google completions');
  f.make('completion', { targetOperationId: work.operationId }, { actor: 'owner', entityId: work.entityId, operationType: 'undo' });
  const restored = project().find(item => item.entry.id === initial.entry.id);
  assert.equal(restored.completedAt, undefined); assert.equal(restored.locallyIncomplete, true); assert.equal(restored.synchronizationBlocked, undefined);
});

test('recurring backlog separates per-member work and never consumes a manually designated round', async () => {
  const f = await init({ preset: 'eachMember', members: ['a', 'b'] });
  complete(f, '2026-09-01', '2026-09-01', 'a'); complete(f, '2026-09-01', '2026-09-01', 'b');
  complete(f, '2026-09-15', '2026-10-01', 'a');
  let plan = f.plan(range);
  assert.equal(rows(plan).find(row => row.round.anchorDate === '2026-09-29' && row.subject.subjectUserId === 'a').subject.automaticBacklog, 'covered');
  assert.equal(pending(plan).find(row => row.subject.subjectUserId === 'b').round.anchorDate, '2026-09-15');
  const common = await init(); complete(common, '2026-09-01', '2026-09-01');
  common.designation(date('2026-10-01'), { day: '2026-09-29' });
  complete(common, '2026-09-15', '2026-10-01'); plan = common.plan(range);
  const designated = rows(plan).find(row => row.round.anchorDate === '2026-09-29');
  assert.equal(designated.subject.formalDate.kind, 'manual'); assert.equal(designated.subject.completed, false);
  assert.equal(designated.subject.automaticBacklog, undefined);
});

test('recurring backlog preserves explicit assignments and keeps distinct chores separate even when names match', async () => {
  const f = await init(); const plan = f.plan(range);
  const first = rows(plan).find(row => row.subject.automaticBacklog === 'pending');
  const assigned = structuredClone(first.round); assigned.anchorDate = '2026-09-29'; assigned.id = 'assigned'; assigned.assignmentOperationIds = ['explicit-assignment'];
  assigned.subjects = [{ ...structuredClone(first.subject), id: 'assigned-subject', automaticBacklog: undefined }];
  const other = structuredClone(first.round); other.choreId = 'another-chore'; other.id = 'another-round'; other.subjects[0].id = 'another-subject';
  applyV2AutomaticBacklog([first.round, assigned, other], new Map(), range.asOfDate);
  assert.equal(assigned.subjects[0].automaticBacklog, undefined);
  assert.equal(first.subject.automaticBacklog, 'pending'); assert.equal(other.subjects[0].automaticBacklog, 'pending');
});

test('one overdue physical completion supplies its actual interval to existing learning and Undo removes exactly that observation', () => {
  const policy = { choreId: 'laundry', kind: 'personal', mode: 'balanced', initialDays: { frequent: 7, balanced: 14, relaxed: 28 }, enabled: true, fixedDays: null, version: 'v1' };
  const days = ['2026-06-01', '2026-07-01', '2026-07-31', '2026-08-30'];
  const due = ['2026-05-15', '2026-06-15', '2026-07-15', '2026-08-14'];
  const events = days.map((day, index) => ({ operationId: `real-${index}`, sequence: index + 1, recordedAt: `${day}T01:00:00Z`,
    type: 'complete', completionId: `work-${index}`, roundId: `oldest-${index}`, localDate: day, timeZone: 'Asia/Tokyo', origin: 'personal',
    mode: 'balanced', initialDays: 14, displayedWindow: { revision: `plan-${index}`, from: due[index], through: due[index] } }));
  const replay = events => replayAdaptiveHistory({ policy, events, forecasts: [], fingerprint: value => createHash('sha256').update(JSON.stringify(value)).digest('hex') });
  assert.equal(replay(events.slice(0, 2)).model.days, 14, 'one late interval does not immediately replace the cycle');
  const state = replay(events); assert.equal(state.validUnitCount, 4); assert.equal(state.validIntervalCount, 3); assert.equal(state.model.days, 30);
  const undone = replay([...events, { operationId: 'undo-last', sequence: 5, recordedAt: '2026-08-30T02:00:00Z', type: 'undo', completionId: 'work-3', targetOperationId: 'real-3' }]);
  assert.equal(undone.validIntervalCount, 2); assert.equal(undone.model.days, 14);
});

for (const platform of ['ios', 'android']) test(`${platform} a quick checkbox on a newer calendar slot completes the oldest unfinished automatic slot and shares its pending count`, async () => {
  const f = await init(); complete(f, '2026-09-01', '2026-09-01'); const plan = f.plan(range);
  const current = rows(plan).find(row => row.round.anchorDate === '2026-09-29');
  const oldest = pending(plan)[0]; let captured;
  const model = { plan, viewerUserId: 'owner', adminUserId: 'owner', configurations: [], assignmentRequests: [] };
  const screen = screenHarness('src/features/sharing/v2-ui/round-card.tsx', { exportName: 'V2RoundCard', platform,
    props: { model, round: current.round, subject: current.subject, busy: false, compact: true, onOpen() {}, run: work => work(),
      actions: { complete: async ref => { captured = ref; return []; } } } });
  try {
    const checkbox = screen.nodes().find(node => node.props.accessibilityRole === 'checkbox'); assert.ok(checkbox.props.onPress);
    await checkbox.props.onPress(); assert.equal(captured.anchorDate, oldest.round.anchorDate); assert.equal(captured.subjectUserId, null);
    const feedback = new Map([[`shared:${oldest.subject.id}`, true]]);
    const before = v2CalendarProjection(model); const after = v2CalendarProjection(model, undefined, feedback);
    assert.equal(after.counts.get('2026-09-30'), 0);
    assert.equal(after.counts.get('2026-10-12'), before.counts.get('2026-10-12'), 'future rounds never inherit a pending backlog completion');
  } finally { screen.unmount(); }
});
