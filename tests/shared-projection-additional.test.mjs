import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/sharing-v2-plan-fixture.mjs';
import { v2CalendarProjection } from '../src/features/sharing/v2-ui/calendar-projection.ts';
import { loadNativeModule } from './helpers/native-module.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { sharedCalendarPayload } from '../src/features/sharing/v2/calendar-state.ts';

test('shared optimistic Undo places an early completed round back on its recommended calendar date', async () => {
  const f = await fixture({ configuration: { anchorDate: '2026-10-28' } });
  f.complete({ actor: 'owner', day: '2026-10-28', performedAt: '2026-10-27T10:00:00Z' });
  const plan = f.plan(); const subject = plan.occurrences.find(row => row.anchorDate === '2026-10-28').subjects[0];
  assert.equal(subject.completed, true);
  const model = { plan, viewerUserId: 'owner', adminUserId: 'owner' };
  const projected = v2CalendarProjection(model, undefined, new Map([[`shared:${subject.id}`, false]]), true);
  assert.ok(projected.byDate.get('2026-10-28')?.some(row => row.id === subject.id));
  assert.ok(!projected.byDate.get('2026-10-27')?.some(row => row.id === subject.id));
});

test('calendar completion visibility cannot disclose another assignee early-completion date by moving its row', async () => {
  const f = await fixture({ preset: 'assigned', members: ['owner'], policy: { showCompletionStatus: false }, configuration: { anchorDate: '2026-10-28' } });
  const before = f.plan(); const subject = before.occurrences.find(row => row.anchorDate === '2026-10-28').subjects[0];
  const dates = plan => [...v2CalendarProjection({ plan, viewerUserId: 'a', adminUserId: 'owner' }, undefined, undefined, true).byDate]
    .filter(([, rows]) => rows.some(row => row.id === subject.id)).map(([date]) => date);
  f.complete({ actor: 'owner', day: '2026-10-28', performedAt: '2026-10-27T10:00:00Z' });
  assert.deepEqual(dates(f.plan()), dates(before));
});

test('shared calendar projection derives each event and repeated category identity once per immutable input batch', () => {
  let digests = 0;
  const { projectSharedCalendarRecords } = loadNativeModule('src/features/calendar/shared-events.ts', {
    '../sharing/crypto.ts': { sharedDocumentDigest(value) { digests++; return sharedDocumentDigest(value); } },
    '../sharing/v2/calendar-state.ts': { sharedCalendarPayload }, './private-availability.ts': {},
  });
  const category = { id: 'personal', name: '私用', color: '#348DC2' };
  const records = Array.from({ length: 100 }, (_, n) => ({ id: `event-${n}`, creatorUserId: 'owner', exceptions: [],
    heads: [{ logicalClock: n + 1, payload: { value: { ...newEventDraft('2026-11-07', 'Asia/Tokyo'), title: `予定${n}` }, category } }] }));
  const result = projectSharedCalendarRecords(records, 'group');
  assert.equal(result.events.length, 100); assert.equal(result.groupCategories.size, 1);
  for (let n = 0; n < 100; n++) assert.equal(result.events[n].id, `group.${sharedDocumentDigest(['group', `event-${n}`])}`);
  assert.ok(digests <= 101, `identity digest requests: ${digests}`);
});
