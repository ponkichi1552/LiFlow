import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
const { prepareAdaptivePlacementInput } = await import('../src/features/planner/adaptive-input.ts');
const { placeAdaptiveRounds } = await import('../src/domain/scheduling/adaptive/placement.ts');
const { newEventDraft } = await import('../src/domain/calendar/events.ts');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const date = '2026-11-03';
const event = (id, change = {}) => ({ ...newEventDraft(date, 'UTC'), id, title: id, revision: 1, startMinute: 540, endMinute: 600, ...change });
const preferences = { restDays: [], heavyLimit: 1, normalLimit: 2, allowedBands: [{ weekday: 2, startMinute: 540, endMinute: 720 }], dayOverrides: [] };
const prepare = (change = {}) => prepareAdaptivePlacementInput({ from: date, through: date, timeZone: 'UTC', preferences,
  events: [], exceptions: [], fingerprint, ...change });
const span = (start, end) => ({ start: Date.parse(start), end: Date.parse(end) });

test('adaptive Calendar geometry unions Google and local copies and distinct busy periods instead of taking daily maxima', () => {
  const input = prepare({ events: [event('local'), event('google-copy')], busy: [span(`${date}T09:00Z`, `${date}T10:00Z`), span(`${date}T10:00Z`, `${date}T11:00Z`)] });
  assert.deepEqual(input.busy, [span(`${date}T09:00Z`, `${date}T11:00Z`)]);
  const result = placeAdaptiveRounds({ ...input, tasks: [{ id: 'round', choreId: 'chore', baseDate: date, periodDays: 7, minutes: 30,
    load: 'normal', purpose: 'direct', fixedDaily: false }], fixedLoads: [], today: date, now: Date.parse(`${date}T00:00Z`) })[0];
  assert.deepEqual(result.slot, span(`${date}T11:00Z`, `${date}T11:30Z`));
});

test('an equally long event moved within a day changes the placement revision while metadata-only changes do not', () => {
  const a = prepare({ events: [event('a')] });
  const b = prepare({ events: [event('a', { startMinute: 600, endMinute: 660 })] });
  assert.notEqual(a.revision, b.revision);
  assert.equal(a.revision, prepare({ events: [event('a', { title: 'renamed', revision: 2, notes: 'private text' })] }).revision);
});

test('holiday and workday date overrides precede weekdays and unconfigured days use approved initial hours', () => {
  const noSetting = prepare({ preferences: { ...preferences, allowedBands: [] } }); assert.deepEqual(noSetting.days[0].allowed, [span(`${date}T19:00Z`, `${date}T21:00Z`)]);
  const holiday = prepare({ preferences: { ...preferences, allowedBands: [], dayOverrides: [{ date, holiday: true }] } });
  assert.deepEqual(holiday.days[0].allowed, [span(`${date}T09:00Z`, `${date}T19:00Z`)]); assert.equal(holiday.holidaysConfigured, true);
  const workday = prepare({ preferences: { ...preferences, restDays: [2], allowedBands: [], dayOverrides: [{ date, holiday: false }] } });
  assert.equal(workday.days[0].holiday, false); assert.deepEqual(workday.days[0].allowed, [span(`${date}T19:00Z`, `${date}T21:00Z`)]);
  const explicit = prepare({ preferences: { ...preferences, restDays: [2], dayOverrides: [{ date, maximumMinutes: 0, allowedBands: [] }] } });
  assert.deepEqual(explicit.days[0].allowed, []); assert.equal(explicit.days[0].maximumMinutes, 0);
  assert.deepEqual(prepare({ preferences: { ...preferences, restDays: [2] } }).days[0].allowed, [span(`${date}T09:00Z`, `${date}T12:00Z`)]);
});

test('birthday transparent and cancelled instances do not reserve time while an opaque all-day event blocks the actual day', () => {
  const birthday = event('birthday', { birthday: true, allDay: true, recurrence: 'yearly', categoryId: 'birthday' });
  const cancelled = event('cancelled');
  const result = prepare({ events: [birthday, event('free', { blocksTime: false }), cancelled], exceptions: [{ eventId: cancelled.id, anchorDate: date, override: null, revision: 1 }] });
  assert.deepEqual(result.busy, []);
  assert.deepEqual(prepare({ events: [event('whole-day', { allDay: true })] }).busy, [span(`${date}T00:00Z`, '2026-11-04T00:00Z')]);
});

test('adaptive daily geometry preserves 23 and 25 hour civil days and unresolved fold bands remain unavailable', () => {
  for (const [date, hours] of [['2026-03-08', 23], ['2026-11-01', 25]]) {
    const value = prepare({ from: date, through: date, timeZone: 'America/New_York', preferences: { ...preferences, restDays: [7], allowedBands: [] } });
    assert.equal((value.days[0].bounds.end - value.days[0].bounds.start) / 3600000, hours);
  }
  const date = '2026-11-01';
  const fold = prepare({ from: date, through: date, timeZone: 'America/New_York', preferences: { ...preferences, restDays: [7],
    allowedBands: [{ weekday: 7, startMinute: 60, endMinute: 180 }] } });
  assert.deepEqual(fold.unresolvedDates, [date]); assert.deepEqual(fold.days[0].allowed, []);
});

test('overlapping weekday bands merge and an explicit invalid or duplicate day setting fails before publishing geometry', () => {
  const merged = prepare({ preferences: { ...preferences, allowedBands: [{ weekday: 2, startMinute: 540, endMinute: 600 }, { weekday: 2, startMinute: 570, endMinute: 660 }] } });
  assert.deepEqual(merged.days[0].allowed, [span(`${date}T09:00Z`, `${date}T11:00Z`)]);
  for (const patch of [{ allowedBands: [{ weekday: 2, startMinute: 600, endMinute: 540 }] }, { dayOverrides: [{ date }, { date }] }, { dayOverrides: [{ date, maximumMinutes: -1 }] }]) {
    assert.throws(() => prepare({ preferences: { ...preferences, ...patch } }));
  }
});
