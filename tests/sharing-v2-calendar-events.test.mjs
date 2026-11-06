import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/sharing-v2-plan-fixture.mjs';
import { newEventDraft } from '../src/domain/calendar/events.ts';
import { readSharedCalendar } from '../src/features/sharing/v2/calendar-state.ts';
const category = { id: 'personal', name: '私用', color: '#3D906A' };
const value = (extra = {}) => ({ ...newEventDraft('2026-10-27', 'Asia/Tokyo'), title: '食事', ...extra });
const change = (eventId, values = {}) => ({ eventId, scope: 'series', anchorDate: null, basisOperationIds: [], resetExceptionIds: [], value: value(), category, ...values });
const accepted = (f, op) => !f.state().assessment.rejected.some(row => row.operationId === op.operationId);

test('shared general events allow member creation and creator or administrator edits but reject another member', async () => {
  const f = await fixture(); const create = f.make('calendarEvent', change('calendar.a'), { actor: 'a', operationId: 'calendar.a' });
  const forbidden = f.make('calendarEvent', change(create.operationId, { basisOperationIds: [create.operationId], value: value({ title: '不正編集' }) }), { actor: 'b' });
  assert.equal(accepted(f, create), true); assert.equal(accepted(f, forbidden), false);
  const own = f.make('calendarEvent', change(create.operationId, { basisOperationIds: [create.operationId], value: value({ title: '本人の変更' }) }), { actor: 'a' });
  assert.equal(accepted(f, own), true);
  const admin = f.make('calendarEvent', change(create.operationId, { basisOperationIds: [own.operationId], value: null, category: null }));
  assert.equal(accepted(f, admin), true); assert.equal(readSharedCalendar(f.state().assessment.view)[0].heads[0].payload.value, null);
});

test('shared event concurrent edits converge as a visible conflict until all observed alternatives are reviewed', async () => {
  const f = await fixture(); const create = f.make('calendarEvent', change('calendar.a'), { actor: 'a', operationId: 'calendar.a' });
  const observed = f.facts.map(fact => fact.operation);
  const first = f.make('calendarEvent', change(create.operationId, { basisOperationIds: [create.operationId], value: value({ title: '本人' }) }), { actor: 'a', observed });
  const second = f.make('calendarEvent', change(create.operationId, { basisOperationIds: [create.operationId], value: value({ title: '管理者' }) }), { observed });
  for (const ordered of [f.facts, [...f.facts].reverse(), [...f.facts, ...f.facts]]) {
    assert.deepEqual(readSharedCalendar(f.state(ordered).assessment.view)[0].heads.map(op => op.operationId).sort(), [first.operationId, second.operationId].sort());
  }
  const missing = f.make('calendarEvent', change(create.operationId, { basisOperationIds: [first.operationId] }), { actor: 'a' });
  assert.equal(accepted(f, missing), false);
  const resolution = f.make('calendarEvent', change(create.operationId, { basisOperationIds: [first.operationId, second.operationId], value: value({ title: '確認済み' }) }), { actor: 'a' });
  assert.equal(accepted(f, resolution), true); assert.equal(readSharedCalendar(f.state().assessment.view)[0].heads.length, 1);
});

test('shared recurring exceptions bind a real occurrence and structural resets explicitly identify the observed exceptions', async () => {
  const f = await fixture(); const series = value({ recurrence: 'weekly', untilDate: '2026-11-10' });
  const create = f.make('calendarEvent', change('calendar.a', { value: series }), { actor: 'a', operationId: 'calendar.a' });
  const one = f.make('calendarEvent', change(create.operationId, { scope: 'one', anchorDate: '2026-11-03', value: { ...series, startDate: '2026-11-04', endDate: '2026-11-04' } }), { actor: 'a' });
  assert.equal(accepted(f, one), true);
  const fakeDate = f.make('calendarEvent', change(create.operationId, { scope: 'one', anchorDate: '2026-11-04', value: null, category: null }), { actor: 'a' });
  assert.equal(accepted(f, fakeDate), false);
  const structural = value({ recurrence: 'monthly' });
  const forgotten = f.make('calendarEvent', change(create.operationId, { basisOperationIds: [create.operationId], value: structural }), { actor: 'a' });
  assert.equal(accepted(f, forgotten), false);
  const reset = f.make('calendarEvent', change(create.operationId, { basisOperationIds: [create.operationId], resetExceptionIds: [one.operationId], value: structural }), { actor: 'a' });
  assert.equal(accepted(f, reset), true); assert.equal(readSharedCalendar(f.state().assessment.view)[0].exceptions.length, 0);
});

test('shared event payload rejects provider IDs and additional private fields rather than forwarding a personal record', async () => {
  const f = await fixture();
  assert.throws(() => f.make('calendarEvent', { ...change('calendar.a'), googleCalendarId: 'private-calendar' }, { operationId: 'calendar.a' }));
  assert.throws(() => f.make('calendarEvent', change('calendar.b', { value: { ...value(), freeBusy: [] } }), { operationId: 'calendar.b' }));
});

test('resetting an edited recurring exception never resurrects its superseded ancestor and a later new exception remains valid', async () => {
  const f = await fixture(); const series = value({ recurrence: 'weekly', untilDate: '2026-11-10' });
  const create = f.make('calendarEvent', change('calendar.reset', { value: series }), { actor: 'a', operationId: 'calendar.reset' });
  const first = f.make('calendarEvent', change(create.operationId, { scope: 'one', anchorDate: '2026-11-03', value: { ...series, title: '古い個別変更' } }), { actor: 'a' });
  const second = f.make('calendarEvent', change(create.operationId, { scope: 'one', anchorDate: '2026-11-03', basisOperationIds: [first.operationId], value: { ...series, title: '最新の個別変更' } }), { actor: 'a' });
  assert.equal(accepted(f, second), true);
  const reset = f.make('calendarEvent', change(create.operationId, { basisOperationIds: [create.operationId], resetExceptionIds: [second.operationId], value: series }), { actor: 'a' });
  assert.equal(accepted(f, reset), true);
  for (const facts of [f.facts, [...f.facts].reverse(), [...f.facts, ...f.facts]]) assert.deepEqual(readSharedCalendar(f.state(facts).assessment.view)[0].exceptions, []);
  const fresh = f.make('calendarEvent', change(create.operationId, { scope: 'one', anchorDate: '2026-11-03', value: { ...series, title: 'リセット後の変更' } }), { actor: 'a' });
  assert.equal(accepted(f, fresh), true);
  assert.deepEqual(readSharedCalendar(f.state().assessment.view)[0].exceptions[0].heads.map(op => op.operationId), [fresh.operationId]);
});

test('resetting one concurrent exception preserves a genuinely concurrent alternative instead of an earlier causal version', async () => {
  const f = await fixture(); const series = value({ recurrence: 'weekly' });
  const create = f.make('calendarEvent', change('calendar.concurrent-reset', { value: series }), { actor: 'a', operationId: 'calendar.concurrent-reset' });
  const ancestor = f.make('calendarEvent', change(create.operationId, { scope: 'one', anchorDate: '2026-11-03', value: series }), { actor: 'a' });
  const observed = f.facts.map(fact => fact.operation);
  const first = f.make('calendarEvent', change(create.operationId, { scope: 'one', anchorDate: '2026-11-03', basisOperationIds: [ancestor.operationId], value: { ...series, title: '本人の変更' } }), { actor: 'a', observed });
  const second = f.make('calendarEvent', change(create.operationId, { scope: 'one', anchorDate: '2026-11-03', basisOperationIds: [ancestor.operationId], value: { ...series, title: '管理者の変更' } }), { observed });
  assert.equal(accepted(f, first), true); assert.equal(accepted(f, second), true);
  const reset = f.make('calendarEvent', change(create.operationId, { basisOperationIds: [create.operationId], resetExceptionIds: [second.operationId], value: series }), { actor: 'a' });
  assert.equal(accepted(f, reset), true);
  assert.deepEqual(readSharedCalendar(f.state().assessment.view)[0].exceptions[0].heads.map(op => op.operationId), [first.operationId]);
});
