import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { newEventDraft } = await import('../src/domain/calendar/events.ts');
const { googleEventBody } = await import('../src/features/calendar/google-event-mapping.ts');
const { googleImportedEvent } = await import('../src/features/calendar/google-event-import.ts');

test('audit100 every supported custom interval can round trip through Google without becoming read only', () => {
  for (const customRecurrence of [{ unit: 'day', interval: 500 }, { unit: 'week', interval: 500, weekdays: [1] }, { unit: 'month', interval: 500, on: 'date' }, { unit: 'year', interval: 500 }]) {
    const value = { ...newEventDraft('2026-11-02', 'UTC'), title: '長い周期', recurrence: 'custom', customRecurrence };
    const remote = { ...googleEventBody(value), id: 'round-trip', etag: '"one"' };
    assert.deepEqual(googleImportedEvent(remote, 'personal', 'UTC'), value);
  }
});
test('audit100 a Google cutoff on a nonoccurrence day does not disable editing of a representable weekly rule', () => {
  const value = { ...newEventDraft('2026-11-02', 'UTC'), title: '毎週', recurrence: 'weekly', untilDate: '2026-11-06' };
  const remote = { ...googleEventBody(value), id: 'weekly', recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261106T080000Z'] };
  assert.deepEqual(googleImportedEvent(remote, 'personal', 'UTC'), value);
});
