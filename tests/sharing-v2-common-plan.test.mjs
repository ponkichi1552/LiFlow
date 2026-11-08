import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, anchorDate, date } from './helpers/sharing-v2-plan-fixture.mjs';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { v2CompletionHistory } from '../src/features/sharing/v2/completion-history.ts';
import { v2ReadPoint } from '../src/features/sharing/v2/view-point.ts';
const slot = (plan, day = anchorDate, subject = null) => plan.occurrences.find((entry) => entry.anchorDate === day)?.subjects.find((entry) => entry.subjectUserId === subject);
const accepted = (f) => assert.deepEqual(f.state().assessment.rejected.map((entry) => [entry.operationId, entry.error.message]), []);

test('v2 common planner separates common and each-member work and preserves immutable actual history after targeted undo', async () => {
  for (const [preset, members, required] of [['common', [], [null]], ['eachMember', [], ['a', 'b', 'owner']], ['assigned', ['a'], [null]]]) {
    const f = await fixture({ preset, members });
    const first = f.plan().occurrences[0]; assert.deepEqual(first.subjects.filter((entry) => entry.required).map((entry) => entry.subjectUserId), required);
    const work = f.complete({ subject: preset === 'eachMember' ? 'a' : null }); accepted(f);
    const plan = f.plan(); assert.equal(plan.occurrences[0].completed, preset !== 'eachMember'); assert.equal(plan.history[0].performerUserId, 'a');
    assert.equal(plan.history[0].recordedAt, '2026-10-27T10:00:00Z'); assert.equal(plan.history[0].performedAt, '2026-10-27T01:00:00Z');
    f.make('completion', { targetOperationId: work.operationId }, { actor: 'a', entityId: work.entityId, operationType: 'undo' }); accepted(f);
    assert.equal(slot(f.plan(), anchorDate, preset === 'eachMember' ? 'a' : null).completed, false);
    assert.equal(f.plan().history.length, 1); assert.equal(f.plan().history[0].active, false);
  }
});
test('v2 common planner keeps real work separate from strict instruction fulfillment and never rewrites it with later dates', async () => {
  const f = await fixture(); const rule = f.designation(date('2026-10-28'), { strict: true });
  const work = f.complete(); accepted(f);
  const before = f.plan().history; assert.equal(before[0].fulfillment, 'earlier'); assert.equal(before[0].strictInstructionFulfilled, false);
  f.designation(date('2026-10-29'), { basisRuleIds: [rule.operationId] }); accepted(f);
  assert.deepEqual(f.plan().history, before); assert.equal(slot(f.plan()).completed, true); assert.equal(slot(f.plan()).suggestedDate, '2026-10-28');
  const bad = f.make('completion', { ...work.payload, recordedInstruction: { kind: 'automatic', timeZone: 'Asia/Tokyo' } }, { actor: 'a', entityId: work.entityId, operationType: 'complete' });
  assert.equal(f.state().assessment.rejected.find((entry) => entry.operationId === bad.operationId)?.kind, 'unauthorized');
});
test('v2 common planner does not invent fulfillment for old reports or revoke accepted work after substitution policy changes', async () => {
  const f = await fixture({ preset: 'assigned', members: ['b'] }); f.complete({ instruction: false }); accepted(f);
  const before = f.plan().history; assert.equal(before[0].fulfillment, 'unknown'); assert.equal(before[0].acceptance, 'accepted');
  f.make('groupPolicy', { configuration: { ...f.plan().policy, allowSubstitution: false } }, { entityId: 'policy' }); accepted(f);
  assert.deepEqual(f.plan().history, before);
});
test('v2 common planner applies short-cycle cooldown only to the matching subject without moving common anchors', async () => {
  for (const cycle of [1, 2, 3, 4, 5, 6, 7, 30]) {
    const f = await fixture({ preset: 'eachMember', cycle, before: 0, after: 2 });
    f.complete({ subject: 'a' }); accepted(f); const plan = f.plan({ through: '2026-12-27' });
    assert.equal(plan.occurrences[1].anchorDate, addDays(anchorDate, cycle));
    assert.equal(slot(plan, anchorDate, 'b').minimumNextExecutionDay, null);
    assert.equal(slot(plan, anchorDate, 'a').minimumNextExecutionDay !== null, cycle >= 2 && cycle <= 6);
    assert.equal(plan.history.length, 1); assert.equal(plan.occurrences[1].subjects.find((entry) => entry.subjectUserId === 'a').completed, false);
  }
});
test('v2 seven-to3650-day recurrences retain the same future anchors after different members complete early or late', async () => {
  for (const preset of ['common', 'eachMember']) for (const cycle of [7, 14, 30, 90, 180, 365, 3650]) {
    const f = await fixture({ preset, cycle, before: 2, after: 2 });
    const range = { from: anchorDate, through: addDays(anchorDate, Math.min(cycle * 3, 3650)), asOfDate: addDays(anchorDate, 2) };
    const frames = plan => plan.occurrences.map(row => [row.id, row.anchorDate, row.windowStart, row.windowEnd]);
    const original = frames(f.plan(range)); assert.ok(original.length >= 2);
    for (const [actor, offset] of [['a', -1], ['b', 1]]) {
      f.complete({ actor, subject: preset === 'eachMember' ? actor : null, performedAt: `${addDays(anchorDate, offset)}T01:00:00Z`,
        recordedAt: `${addDays(anchorDate, 2)}T01:00:00Z`, receivedAt: `${addDays(anchorDate, 2)}T02:00:00Z` });
      accepted(f); const plan = f.plan(range); assert.deepEqual(frames(plan), original, `${preset}/${cycle}/${actor}`);
      assert.ok(plan.occurrences.flatMap(row => row.subjects).every(subject => subject.minimumNextExecutionDay === null));
      assert.ok(plan.occurrences.slice(1).flatMap(row => row.subjects).every(subject => !subject.completed));
    }
    const next = f.plan({ ...range, from: addDays(anchorDate, cycle) }); assert.deepEqual(frames(next), original.slice(1));
    assert.equal(next.history.length, 2, 'narrowing the visible horizon never removes actual work');
  }
});
test('v2 common planner keeps one oldest expired backlog visible without inventing completion after five days', async () => {
  const f = await fixture({ before: 0, after: 0 });
  for (let age = 0; age <= 6; age++) {
    const asOfDate = age <= 4 ? `2026-10-${27 + age}` : `2026-11-0${age - 4}`;
    const plan = f.plan({ asOfDate }); const s = slot(plan);
    assert.equal(s.virtuallyConsumed, false); assert.equal(s.automaticBacklog, 'pending'); assert.equal(s.showExpiredOnHome, age >= 1);
    assert.equal(s.completed, false); assert.equal(plan.history.length, 0);
  }
});
test('v2 common planner excludes verified future-dated actual work from cooldown and effective completion', async () => {
  const f = await fixture({ cycle: 3 }); f.complete({ performedAt: '2028-10-27T00:00:00Z', recordedAt: '2028-10-27T00:00:00Z' }); accepted(f);
  const plan = f.plan(); assert.equal(plan.history.length, 1); assert.equal(slot(plan).completed, false);
  assert.equal(slot(plan).minimumNextExecutionDay, null); assert.ok(plan.issues.some((issue) => issue.kind === 'reportedTimeNeedsReview'));
});
test('v2 common planner keeps a completed round complete when its assigned members change later', async () => {
  const f = await fixture({ preset: 'eachMember' });
  for (const actor of ['a', 'b', 'owner']) f.complete({ actor, subject: actor });
  const before = f.plan().history;
  f.make('assignmentRule', { choreId: 'floor', fromOccurrenceId: f.occurrence(), fromAnchorDate: anchorDate, scope: 'from', ruleVersion: 1, memberIds: ['a'], fixed: true }); accepted(f);
  const plan = f.plan(); assert.equal(plan.occurrences[0].completed, true); assert.deepEqual(plan.occurrences[0].subjectUserIds, ['a', 'b', 'owner']); assert.deepEqual(plan.history, before);
});
test('v2 common planner uses explicit activity boundaries for unknown-date activation and keeps disabled intervals empty', async () => {
  const f = await fixture({ cycle: 1, configuration: { active: true, effectiveFrom: anchorDate } });
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 2, active: false, effectiveFrom: '2026-10-29' } }, { entityId: 'floor' });
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, anchorDate: '2026-11-02', ruleVersion: 3, active: true, effectiveFrom: '2026-11-02' } }, { entityId: 'floor' }); accepted(f);
  const plan = f.plan({ through: '2026-11-03' }); assert.deepEqual(plan.occurrences.map((entry) => entry.anchorDate), ['2026-10-27', '2026-10-28', '2026-11-02', '2026-11-03']);
});
test('v2 common planner retains completed old anchors across a cadence change and quarantines missing revision boundaries', async () => {
  const f = await fixture(); f.complete(); const before = f.plan().history;
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, anchorDate: '2026-10-28', ruleVersion: 2, intervalDays: 3, effectiveFrom: '2026-10-28' } }, { entityId: 'floor' }); accepted(f);
  let plan = f.plan(); assert.deepEqual(plan.history, before); assert.equal(slot(plan).completed, true); assert.ok(plan.occurrences.some((entry) => entry.anchorDate === '2026-10-31'));
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, anchorDate: '2026-11-02', ruleVersion: 3 } }, { entityId: 'floor' }); accepted(f);
  plan = f.plan(); assert.ok(plan.issues.some((entry) => entry.kind === 'effectiveDateRequired')); assert.deepEqual(plan.history, before);
});
test('v2 common planner yields identical output across reversed receipt input and duplicate/reordered source delivery', async () => {
  const f = await fixture({ preset: 'eachMember' }); f.complete({ subject: 'a' });
  const original = f.plan(); const reverse = f.plan({}, [...f.facts].reverse()); assert.deepEqual(reverse, original);
  const receipts = [...f.receipts].reverse(); f.receipts.clear(); receipts.forEach(([id, receipt]) => f.receipts.set(id, receipt));
  assert.deepEqual(f.plan(), original); assert.equal(JSON.stringify(original).includes('householdId'), false);
});

test('v2 causal-cut approval permits legitimate children while later contradictory answers reopen review until explicitly resolved', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); const locked = f.designation(date('2026-10-28'), { adminLocked: true });
  const request = f.make('changeRequest', { requesterUserId: 'a', choreId: 'floor', anchorDate, occurrenceId: f.occurrence(), subjectUserId: null,
    originalDesignationId: locked.operationId, original: date('2026-10-28'), proposed: date('2026-10-29'), proposedMode: 'day',
    proposedOptions: { strict: false, adminLocked: true, forbidEarlier: false }, selector: { scope: 'once', occurrenceId: f.occurrence(), anchorDate }, extensionScope: 'once' }, { actor: 'a' });
  const branch = f.facts.map((fact) => fact.operation);
  const approval = f.make('requestDecision', { requestId: request.operationId, decision: 'approve', target: null, referenceDecisionId: null }, { observed: branch }); accepted(f);
  const approved = f.state().assessment.approvedRules[0]; assert.ok(approved);
  const child = f.designation(date('2026-10-30'), { basisRuleIds: [approved.operationId] }); accepted(f);
  const reject = f.make('requestDecision', { requestId: request.operationId, decision: 'reject', target: null, referenceDecisionId: null }, { actor: 'owner2', observed: branch }); accepted(f);
  const state = f.state().assessment; assert.equal(state.requestStates[0].kind, 'conflict');
  assert.ok(state.view.byId(child.operationId)); assert.equal(slot(f.plan()).formalDate.target.date, '2026-10-30');
  assert.deepEqual(slot(f.plan()).requestReviewIds, [request.operationId]);
  const all = f.facts.map((fact) => fact.operation);
  f.designation(date('2026-10-29'), { basisRuleIds: [child.operationId], reviewedRequestIds: [request.operationId], observed: all }); accepted(f);
  assert.deepEqual(slot(f.plan()).requestReviewIds, []);
  assert.deepEqual(f.plan({}, [...f.facts].reverse()), f.plan()); assert.ok(approval && reject);
});
test('v2 a conflict-review annotation cannot acknowledge unseen or unrelated answers', async () => {
  const f = await fixture(); const bad = f.designation(date('2026-10-28'), { reviewedRequestIds: ['unknown-request'] });
  assert.equal(f.state().assessment.rejected.find((entry) => entry.operationId === bad.operationId)?.kind, 'unauthorized');
  assert.equal(slot(f.plan()).formalDate.kind, 'automatic');
});
test('v2 conflict resolution observes every candidate and retains completion truth while choosing the formal date', async () => {
  const f = await fixture(); const base = f.facts.map((fact) => fact.operation);
  const a = f.designation(date('2026-10-28'), { observed: base }); const b = f.designation(date('2026-10-29'), { actor: 'owner2', observed: base }); accepted(f);
  assert.equal(slot(f.plan()).formalDate.kind, 'conflict');
  f.complete(); accepted(f); assert.equal(f.plan().history[0].fulfillment, 'unconfirmed');
  f.designation(date('2026-10-30'), { basisRuleIds: [a.operationId, b.operationId] }); accepted(f);
  assert.equal(slot(f.plan()).formalDate.kind, 'manual'); assert.equal(slot(f.plan()).completed, true); assert.equal(f.plan().history[0].fulfillment, 'unconfirmed');
});
test('v2 future common-window expansion requires administrator confirmation and cannot borrow roommate self approval', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'], kind: 'roommates' });
  const request = f.make('changeRequest', { requesterUserId: 'a', choreId: 'floor', anchorDate, occurrenceId: f.occurrence(), subjectUserId: null,
    originalDesignationId: null, original: date(anchorDate), proposed: date('2026-10-31'), proposedMode: 'day',
    proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, selector: { scope: 'once', occurrenceId: f.occurrence(), anchorDate }, extensionScope: 'future' }, { actor: 'a' }); accepted(f);
  assert.equal(f.state().assessment.requestStates[0].kind, 'awaiting'); assert.equal(f.plan().occurrences[0].windowEnd, '2026-10-29');
  f.make('requestDecision', { requestId: request.operationId, decision: 'approve', target: null, referenceDecisionId: null }); accepted(f);
  assert.equal(f.plan().occurrences[0].windowEnd, '2026-10-31'); assert.equal(f.plan().occurrences[1].windowEnd, '2026-11-07');
  assert.equal(f.plan().occurrences[1].anchorDate, '2026-11-03');
});
test('v2 overlapping fixed intervals flag all affected subjects without treating touching intervals or different assignees as conflicts', async () => {
  const f = await fixture({ preset: 'eachMember' }); const base = f.facts.map((fact) => fact.operation);
  const interval = (start, end) => ({ precision: 'interval', start: `2026-10-27T${start}:00Z`, end: `2026-10-27T${end}:00Z` });
  f.designation(interval('01:00', '03:00'), { subjectUserId: 'a', observed: base });
  f.designation(interval('03:00', '04:00'), { subjectUserId: 'b', actor: 'owner2', observed: base }); accepted(f);
  assert.equal(f.plan().issues.some((entry) => entry.kind === 'fixedOverlap'), false);
});

test('v2 common dependency matching uses dates across different cycles and a completed predecessor outside the visible range', async () => {
  const f = await fixture({ cycle: 1, before: 0, after: 1, configuration: { anchorDate: '2026-10-25' } });
  f.make('chore', { name: '月次の準備', enabled: true }, { entityId: 'monthly' });
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, anchorDate: '2026-10-25', intervalDays: 30 } }, { entityId: 'monthly' });
  const { v2OccurrenceId } = await import('../src/features/sharing/v2/occurrence-id.ts');
  f.make('completion', { choreId: 'monthly', anchorDate: '2026-10-25', completedAt: '2026-10-25T01:00:00Z', completedByMemberId: 'a', subjectUserId: null,
    originalAssigneeIds: [], ruleVersion: 1, outcome: 'completed' }, { actor: 'a', entityId: v2OccurrenceId('v2-plan-test', 'monthly', '2026-10-25'), operationType: 'complete' });
  f.make('dependency', { predecessorChoreId: 'monthly', successorChoreId: 'floor', policyData: { required: true } }, { entityId: 'monthly-before-daily' }); accepted(f);
  const plan = f.plan({ from: '2026-10-26', through: '2026-11-01' }); assert.equal(plan.dependencies.length, 1);
  const daily = plan.occurrences.filter((entry) => entry.choreId === 'floor');
  assert.equal(daily.filter(entry => entry.anchorDate >= plan.range.from && entry.anchorDate <= plan.range.through).length, 7);
  assert.equal(daily.find(entry => entry.subjects.some(subject => subject.automaticBacklog === 'pending')).anchorDate, '2026-10-25');
  for (const occurrence of daily) { assert.equal(occurrence.subjects[0].dependencyBlocked, false); assert.equal(occurrence.subjects[0].suggestedDate, occurrence.anchorDate); }
});
test('v2 mandatory dependency violations stay visible for review while optional order and unrelated chores remain usable', async () => {
  const f = await fixture({ cycle: 1, before: 0, after: 0 });
  f.make('chore', { name: '先行', enabled: true }, { entityId: 'prepare' });
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, intervalDays: 30, anchorDate: '2026-11-01' } }, { entityId: 'prepare' });
  f.make('dependency', { predecessorChoreId: 'prepare', successorChoreId: 'floor', policyData: { required: true } }, { entityId: 'order' }); accepted(f);
  let plan = f.plan(); assert.equal(slot(plan).dependencyBlocked, true); assert.ok(plan.occurrences.some((entry) => entry.choreId === 'prepare'));
  f.make('dependency', { policyData: { required: false } }, { entityId: 'order' }); accepted(f);
  plan = f.plan(); assert.equal(slot(plan).dependencyBlocked, false); assert.ok(plan.issues.some((entry) => entry.kind === 'optionalDependencyWarning'));
});
test('v2 dependency cycles and unrecognized policy data are scoped reviews rather than missing rounds', async () => {
  const f = await fixture();
  f.make('dependency', { predecessorChoreId: 'floor', successorChoreId: 'floor', policyData: { required: true } }, { entityId: 'loop' }); accepted(f);
  const plan = f.plan(); assert.ok(plan.occurrences.length); assert.ok(plan.issues.some((entry) => entry.kind === 'dependencyCycle')); assert.equal(slot(plan).dependencyBlocked, true);
  f.make('dependency', { predecessorChoreId: 'floor', successorChoreId: 'floor', policyData: { unknownRule: true } }, { entityId: 'future-policy' }); accepted(f);
  assert.ok(f.plan().issues.some((entry) => entry.kind === 'dependencyPolicyNeedsReview'));
});
test('v2 repeating manual dates remain visible when their stable anchors are outside the requested calendar month', async () => {
  const f = await fixture(); f.designation(date('2026-12-26'), { selector: { scope: 'ongoing', from: anchorDate } }); accepted(f);
  const plan = f.plan({ from: '2026-12-26', through: '2026-12-31' });
  assert.equal(slot(plan).suggestedDate, '2026-12-26'); assert.equal(slot(plan).formalDate.kind, 'manual');
});
test('v2 configuration changes cannot reuse a completed common ID as new each-member work', async () => {
  const f = await fixture(); f.complete();
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, policy: { completion: 'perMember', assignment: { mode: 'all', memberIds: [] } }, ruleVersion: 2, effectiveFrom: anchorDate } }, { entityId: 'floor' }); accepted(f);
  const plan = f.plan(); assert.equal(plan.occurrences[0].completed, true); assert.equal(plan.occurrences[0].configuration.ruleVersion, 1);
  assert.equal(plan.occurrences[1].configuration.ruleVersion, 2); assert.ok(plan.issues.some((entry) => entry.kind === 'configurationChangedDuringRound'));
});

test('v2 receiver refuses new dates and counteroffers before a required predecessor but accepts a later resolving date', async () => {
  const f = await fixture({ cycle: 1, before: 0, after: 0 });
  f.make('chore', { name: '先行する準備', enabled: true }, { entityId: 'prepare' });
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, anchorDate: '2026-11-01', intervalDays: 30 } }, { entityId: 'prepare' });
  f.make('dependency', { predecessorChoreId: 'prepare', successorChoreId: 'floor', policyData: { required: true } }, { entityId: 'required-order' }); accepted(f);
  const before = f.facts.map((fact) => fact.operation);
  const invalid = f.designation(date('2026-10-28')); assert.equal(f.state().assessment.rejected.find((entry) => entry.operationId === invalid.operationId)?.kind, 'unauthorized');
  const valid = f.designation(date('2026-11-02'), { actor: 'owner2', observed: before });
  assert.equal(f.state().assessment.rejected.length, 1); assert.equal(slot(f.plan()).formalDate.target.date, '2026-11-02');
  const request = f.make('changeRequest', { requesterUserId: 'a', choreId: 'floor', anchorDate, occurrenceId: f.occurrence(), subjectUserId: null,
    originalDesignationId: valid.operationId, original: date('2026-11-02'), proposed: date('2026-11-03'), proposedMode: 'day',
    proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, selector: { scope: 'once', occurrenceId: f.occurrence(), anchorDate }, extensionScope: 'once' }, { actor: 'a' });
  const offer = f.make('requestDecision', { requestId: request.operationId, decision: 'counteroffer', target: date('2026-10-29'), referenceDecisionId: null });
  assert.equal(f.state().assessment.rejected.find((entry) => entry.operationId === offer.operationId)?.kind, 'unauthorized');
  assert.equal(f.state().assessment.requestStates[0].kind, 'awaiting');
});
test('v2 dependency cycle detection handles a long graph without recursive call-stack limits and identifies only its actual cycle', async () => {
  const { cyclicV2Dependencies } = await import('../src/features/sharing/v2/dependency-constraints.ts');
  const edges = Array.from({ length: 12000 }, (_, i) => ({ id: `edge-${i}`, predecessorChoreId: `chore-${i}`, successorChoreId: `chore-${i + 1}`, required: true, minimumGapDays: 0 }));
  edges.push({ id: 'back', predecessorChoreId: 'chore-12000', successorChoreId: 'chore-11999', required: true, minimumGapDays: 0 });
  assert.deepEqual([...cyclicV2Dependencies(edges)].sort(), ['back', 'edge-11999']);
});

test('v2 late actual work suppresses only its own short-cycle next round without consuming another member or inventing completion', async () => {
  for (const cycle of [2, 3, 4, 5, 6]) {
    const f = await fixture({ preset: 'eachMember', cycle, before: 0, after: 0 });
    f.complete({ subject: 'a', performedAt: '2026-10-28T00:00:00Z', recordedAt: '2026-10-28T01:00:00Z', receivedAt: '2026-10-28T02:00:00Z' }); accepted(f);
    const plan = f.plan({ asOfDate: '2026-10-28' }); const next = plan.occurrences[1];
    const a = next.subjects.find((entry) => entry.subjectUserId === 'a'); const b = next.subjects.find((entry) => entry.subjectUserId === 'b');
    assert.equal(a.cooldownSuppressed, true); assert.equal(a.virtuallyConsumed, true); assert.equal(a.completed, false);
    assert.equal(b.cooldownSuppressed, false); assert.equal(b.virtuallyConsumed, false); assert.equal(plan.history.length, 1);
  }
});
test('v2 fixed overlap sweep finds concurrent shared clashes while ignoring other people and touching intervals', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] });
  for (const [id, member] of [['mop', 'a'], ['touch', 'a'], ['other', 'b']]) {
    f.make('chore', { name: id, enabled: true }, { entityId: id });
    f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, policy: { completion: 'one', assignment: { mode: 'selected', memberIds: [member] } } } }, { entityId: id });
  }
  const { v2OccurrenceId } = await import('../src/features/sharing/v2/occurrence-id.ts');
  const interval = (start, end) => ({ precision: 'interval', start: `2026-10-27T${start}:00Z`, end: `2026-10-27T${end}:00Z` });
  const on = (id) => ({ choreId: id, selector: { scope: 'once', occurrenceId: v2OccurrenceId('v2-plan-test', id, anchorDate), anchorDate } });
  const base = f.facts.map((fact) => fact.operation);
  f.designation(interval('01:00', '03:00'), { observed: base });
  f.designation(interval('01:30', '02:00'), { ...on('mop'), actor: 'owner2', observed: base });
  f.designation(interval('01:00', '04:00'), on('other'));
  f.designation(interval('03:00', '04:00'), { ...on('touch'), actor: 'owner2' }); accepted(f);
  assert.deepEqual(f.plan().issues.filter((entry) => entry.kind === 'fixedOverlap').map((entry) => entry.choreId).sort(), ['floor', 'mop']);
});

test('v2 dependency fallback ignores empty historical cadence slices rather than waiting for a cancelled initial configuration', async () => {
  const f = await fixture({ cycle: 1, before: 0, after: 1, configuration: { anchorDate: '2026-10-26' } });
  f.make('chore', { name: '先行家事', enabled: true }, { entityId: 'prepare' });
  const cfg = { ...f.defaultConfiguration, anchorDate, intervalDays: 30, windowAfterDays: 14 };
  f.make('chorePolicy', { configuration: cfg }, { entityId: 'prepare' });
  f.make('chorePolicy', { configuration: { ...cfg, effectiveFrom: anchorDate, ruleVersion: 2, windowAfterDays: 0 } }, { entityId: 'prepare' });
  f.make('dependency', { predecessorChoreId: 'prepare', successorChoreId: 'floor', policyData: { required: true } }, { entityId: 'order' }); accepted(f);
  const s = slot(f.plan({ from: '2026-10-26', through: '2026-10-26', asOfDate: '2026-10-26' }), '2026-10-26');
  assert.equal(s.dependencyNotBefore, anchorDate); assert.equal(s.dependencyBlocked, false); assert.equal(s.dependencyAwaitingCompletion, true);
});
test('v2 dependency history keeps an already completed prerequisite satisfied after same-anchor policy changes', async () => {
  const f = await fixture(); f.complete();
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, policy: { completion: 'perMember', assignment: { mode: 'all', memberIds: [] } }, ruleVersion: 2, effectiveFrom: anchorDate } }, { entityId: 'floor' });
  f.make('chore', { name: '後続家事', enabled: true }, { entityId: 'after' });
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, windowBeforeDays: 0, windowAfterDays: 0 } }, { entityId: 'after' });
  f.make('dependency', { predecessorChoreId: 'floor', successorChoreId: 'after', policyData: { required: true } }, { entityId: 'order' }); accepted(f);
  const after = f.plan().occurrences.find((entry) => entry.choreId === 'after' && entry.anchorDate === anchorDate).subjects[0];
  assert.equal(after.dependencyBlocked, false); assert.equal(after.dependencyAwaitingCompletion, false); assert.equal(after.suggestedDate, anchorDate);
});

test('v2 one-off date exceptions keep their original common anchor and remain active across a cadence revision', async () => {
  const f = await fixture(); const anchor = '2026-11-10';
  const once = f.designation(date('2026-11-11'), { day: anchor }); accepted(f);
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, intervalDays: 3, anchorDate: '2026-10-28', effectiveFrom: '2026-10-28', ruleVersion: 2 } }, { entityId: 'floor' }); accepted(f);
  const plan = f.plan({ from: '2026-11-11', through: '2026-11-11' }); const s = slot(plan, anchor);
  assert.ok(s, 'the old anchor is still represented even when it is not part of the new cadence');
  assert.equal(s.formalDate.ruleId, once.operationId); assert.equal(s.suggestedDate, '2026-11-11');
  assert.equal(plan.occurrences.find((round) => round.anchorDate === anchor).activeInPeriod, true);
  assert.equal(s.completed, false); assert.equal(plan.history.length, 0);
});
test('v2 exact deadlines cannot precede the end of a same-day required fixed task assigned to another member', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] });
  f.make('chore', { name: '先行作業', enabled: true }, { entityId: 'prepare' });
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, policy: { completion: 'one', assignment: { mode: 'selected', memberIds: ['owner'] } } } }, { entityId: 'prepare' });
  const { v2OccurrenceId } = await import('../src/features/sharing/v2/occurrence-id.ts');
  f.designation({ precision: 'interval', start: '2026-10-27T01:00:00Z', end: '2026-10-27T03:00:00Z' }, { choreId: 'prepare', selector: { scope: 'once', occurrenceId: v2OccurrenceId('v2-plan-test', 'prepare', anchorDate), anchorDate } });
  f.make('dependency', { predecessorChoreId: 'prepare', successorChoreId: 'floor', policyData: { required: true } }, { entityId: 'order' }); accepted(f);
  const old = f.facts.map((fact) => fact.operation);
  const invalid = f.designation({ precision: 'instant', at: '2026-10-27T02:00:00Z' }, { mode: 'deadline' });
  assert.equal(f.state().assessment.rejected.find((entry) => entry.operationId === invalid.operationId)?.kind, 'unauthorized');
  const valid = f.designation({ precision: 'instant', at: '2026-10-27T03:00:00Z' }, { actor: 'owner2', mode: 'deadline', observed: old });
  assert.ok(f.state().assessment.view.byId(valid.operationId));
});

test('v2 assignment conflicts remain visible through unrelated configuration edits and a signed administrator resolution clears them', async () => {
  const f = await fixture(); const base = f.facts.map((fact) => fact.operation);
  const assignment = (uid, actor) => f.make('assignmentRule', { choreId: 'floor', fromOccurrenceId: f.occurrence(), fromAnchorDate: anchorDate, scope: 'from', ruleVersion: 1, memberIds: [uid], fixed: true }, { actor, observed: base });
  const a = assignment('a', 'owner'); const b = assignment('b', 'owner2'); accepted(f);
  let plan = f.plan(); assert.deepEqual(plan.occurrences[0].assignmentConflictIds, [a.operationId, b.operationId]); assert.equal(plan.occurrences[0].needsAssignment, true);
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 2, effectiveFrom: anchorDate, windowAfterDays: 3, assignmentSourceVersion: 1 } }, { entityId: 'floor' }); accepted(f);
  plan = f.plan(); assert.deepEqual(plan.occurrences[0].assignmentConflictIds, [a.operationId, b.operationId]);
  assert.equal(f.state().assessment.view.ofType('assignmentRule').length, 2);
  f.make('assignmentRule', { choreId: 'floor', fromOccurrenceId: f.occurrence(), fromAnchorDate: anchorDate, scope: 'from', ruleVersion: 2, memberIds: ['b'], fixed: true }); accepted(f);
  plan = f.plan(); assert.deepEqual(plan.occurrences[0].assignmentConflictIds, []); assert.deepEqual(plan.occurrences[0].assigneeIds, ['b']);
});
test('v2 assignment resolution does not reopen work that was already complete before conflicting edits', async () => {
  const f = await fixture({ preset: 'eachMember' });
  for (const actor of ['a', 'b', 'owner']) f.complete({ actor, subject: actor });
  const base = f.facts.map((fact) => fact.operation); const before = f.plan().history;
  for (const [actor, uid] of [['owner', 'a'], ['owner2', 'b']]) f.make('assignmentRule', { choreId: 'floor', fromOccurrenceId: f.occurrence(), fromAnchorDate: anchorDate,
    scope: 'from', ruleVersion: 1, memberIds: [uid], fixed: true }, { actor, observed: base }); accepted(f);
  let plan = f.plan(); assert.equal(plan.occurrences[0].completed, true); assert.deepEqual(plan.occurrences[0].subjectUserIds, ['a', 'b', 'owner']);
  f.make('assignmentRule', { choreId: 'floor', fromOccurrenceId: f.occurrence(), fromAnchorDate: anchorDate, scope: 'from', ruleVersion: 1, memberIds: ['b'], fixed: true }); accepted(f);
  plan = f.plan(); assert.equal(plan.occurrences[0].completed, true); assert.deepEqual(plan.history, before);
});
test('v2 semantically equal member selections merge across ordering differences without manufacturing a setting conflict', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a', 'b'] }); const base = f.facts.map((fact) => fact.operation);
  for (const [actor, memberIds] of [['owner', ['a', 'b']], ['owner2', ['b', 'a']]]) {
    f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, policy: { completion: 'one', assignment: { mode: 'selected', memberIds } },
      ruleVersion: 2, effectiveFrom: anchorDate } }, { actor, observed: base, entityId: 'floor' });
  }
  accepted(f); const plan = f.plan(); assert.deepEqual(plan.occurrences[0].assigneeIds, ['a', 'b']); assert.equal(plan.occurrences[0].needsAssignment, false);
});

test('v2 administrators can explicitly cancel a repeating clock rule after timezone changes without rewriting work or silently remapping the clock', async () => {
  const f = await fixture(); const rule = f.designation({ precision: 'interval', start: '2026-10-27T01:00:00Z', end: '2026-10-27T02:00:00Z' }, { selector: { scope: 'ongoing', from: anchorDate } });
  f.complete(); accepted(f); const before = f.plan().history;
  f.make('settings', { timeZone: 'America/New_York' }, { entityId: 'settings' }); accepted(f);
  assert.equal(slot(f.plan()).formalDate.kind, 'manual'); assert.equal(slot(f.plan()).formalDate.timeZone, 'Asia/Tokyo');
  f.make('designationCancel', { targetOperationIds: [rule.operationId] }); accepted(f);
  const plan = f.plan(); assert.deepEqual(plan.history, before); assert.equal(slot(plan).formalDate.kind, 'automatic');
});

test('v2 larger cadence revisions cannot erase an unseen concurrent future configuration and a causal resolution closes only the disputed period', async () => {
  const f = await fixture(); const base = f.facts.map((fact) => fact.operation);
  const a = f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 2, intervalDays: 3, anchorDate: '2026-10-28', effectiveFrom: '2026-10-28' } }, { entityId: 'floor', observed: base });
  const b = f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 2, intervalDays: 14, anchorDate: '2026-11-10', effectiveFrom: '2026-11-10' } }, { entityId: 'floor', actor: 'owner2', observed: base });
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 3, intervalDays: 5, anchorDate: '2026-11-03', effectiveFrom: '2026-11-03' } }, { entityId: 'floor', observed: [...base, a] }); accepted(f);
  let plan = f.plan({ from: '2026-11-01', through: '2026-11-20' });
  assert.ok(plan.occurrences.some((entry) => entry.anchorDate === '2026-11-08')); assert.ok(plan.issues.some((entry) => entry.kind === 'configurationConflict'));
  assert.equal(plan.occurrences.some((entry) => entry.anchorDate >= '2026-11-10'), false);
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 4, anchorDate: '2026-11-15', effectiveFrom: '2026-11-15' } }, { entityId: 'floor' }); accepted(f);
  plan = f.plan({ from: '2026-11-15', through: '2026-11-20' }); assert.ok(plan.occurrences.some((entry) => entry.anchorDate === '2026-11-15'));
  assert.equal(plan.issues.some((entry) => entry.kind === 'configurationConflict'), false); assert.ok(b);
});
test('v2 explicit future revisions can recover from a nonmonotonic historical boundary without erasing that historical review', async () => {
  const f = await fixture();
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 2, anchorDate: '2026-11-10', effectiveFrom: '2026-11-10' } }, { entityId: 'floor' });
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 3, anchorDate: '2026-11-03', effectiveFrom: '2026-11-03' } }, { entityId: 'floor' }); accepted(f);
  assert.ok(f.plan({ from: '2026-11-03', through: '2026-11-12' }).issues.some((entry) => entry.kind === 'nonmonotonicEffectiveDate'));
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 4, anchorDate: '2026-11-15', effectiveFrom: '2026-11-15' } }, { entityId: 'floor' }); accepted(f);
  const plan = f.plan({ from: '2026-11-15', through: '2026-11-20' }); assert.ok(plan.occurrences.some((entry) => entry.anchorDate === '2026-11-15'));
  assert.equal(plan.issues.some((entry) => entry.kind === 'nonmonotonicEffectiveDate'), false);
});

test('v2 an unseen concurrent cancellation cannot rewrite the common window captured by a legitimate work report', async () => {
  const f = await fixture(); const request = f.make('changeRequest', { requesterUserId: 'owner', choreId: 'floor', anchorDate, occurrenceId: f.occurrence(), subjectUserId: null,
    originalDesignationId: null, original: date(anchorDate), proposed: date('2026-10-31'), proposedMode: 'day', proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false },
    selector: { scope: 'once', occurrenceId: f.occurrence(), anchorDate }, extensionScope: 'future' }); accepted(f);
  const rule = f.state().assessment.approvedRules[0]; assert.ok(rule); const base = f.facts.map((fact) => fact.operation);
  const work = f.complete({ recordedCommonWindow: { start: '2026-10-25', end: '2026-10-31' }, scheduledDate: '2026-10-31', scheduledWindowStart: '2026-10-25', scheduledWindowEnd: '2026-10-31' });
  f.make('designationCancel', { targetOperationIds: [rule.operationId] }, { actor: 'owner2', observed: base, operationId: 'aaa-concurrent-cancel' }); accepted(f);
  const plan = f.plan(); assert.equal(plan.history.find((record) => record.operationId === work.operationId).schedule.commonWindow.end, '2026-10-31');
  assert.equal(plan.occurrences[0].windowEnd, '2026-10-29'); assert.ok(request);
});

test('v2 round-scoped history retains subject-specific work, approvals and undo without scanning every completion for each round', async () => {
  const f = await fixture({ preset: 'eachMember' }); const first = f.complete({ subject: 'a' }); const second = f.complete({ subject: 'b', day: addDays(anchorDate, 7) });
  f.make('completion', { targetOperationId: first.operationId }, { actor: 'a', entityId: first.entityId, operationType: 'undo' }); accepted(f);
  const s = f.state(); const at = v2ReadPoint(s.assessment.view, f.archive.at(-1)); const view = { ...s.assessment.view, ofType: () => { throw new Error('Global history scan'); } };
  const one = v2CompletionHistory(view, at, f.receipts, { choreId: 'floor', anchorDate }); assert.equal(one.length, 1); assert.equal(one[0].operationId, first.operationId); assert.equal(one[0].active, false);
  const two = v2CompletionHistory(view, at, f.receipts, { choreId: 'floor', anchorDate: addDays(anchorDate, 7) }); assert.equal(two.length, 1); assert.equal(two[0].operationId, second.operationId); assert.equal(two[0].active, true);
});
