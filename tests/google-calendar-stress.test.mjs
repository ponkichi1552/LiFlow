import assert from 'node:assert/strict';
import test from 'node:test';
import moment from 'moment-timezone';
import './helpers/typescript-loader.mjs';

const { createCalendarFreeBusyClient, CalendarFreeBusyError } = await import('../src/platform/google-tasks/google-calendar-freebusy-client.ts');
const { createCalendarQueryRange, aggregateBusyMinutes } = await import('../src/features/google-sync/calendar-availability.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');
const stamp = '2026-10-26T00:00:00.000Z';
const payload = (busy) => ({ calendars: { primary: { busy } } });

test('FreeBusy retains 150000 intervals without exceeding the JavaScript argument stack', async () => {
  const range = createCalendarQueryRange('2026-10-26', '2026-10-26', 'UTC');
  const busy = Array.from({ length: 150_000 }, () => ({ start: '2026-10-26T10:00:00Z', end: '2026-10-26T11:00:00Z' }));
  let calls = 0;
  const client = createCalendarFreeBusyClient(async () => { calls++; return Response.json(payload(busy)); });
  const intervals = await client.query('fixture-token', range);
  assert.equal(intervals.length, busy.length);
  assert.equal(calls, 1);
  assert.deepEqual(aggregateBusyMinutes(intervals, range, stamp).map((day) => day.busyMinutes), [60]);
});

test('100000 disjoint Calendar intervals retain exact daily totals over 181 days', () => {
  const range = createCalendarQueryRange('2026-10-26', '2027-04-24', 'UTC');
  const minimum = Date.parse(range.timeMin);
  const busy = Array.from({ length: 100_000 }, (_, index) => ({
    start: new Date(minimum + index * 120_000).toISOString(), end: new Date(minimum + index * 120_000 + 60_000).toISOString(),
  }));
  const rows = aggregateBusyMinutes(busy, range, stamp);
  assert.equal(rows.length, 181);
  assert.deepEqual(rows.map(({ busyMinutes }) => busyMinutes), Array.from({ length: 181 }, (_, index) => Math.max(0, Math.min(720, 100_000 - index * 720))));
});

for (const days of [1, 2, 89, 90, 91, 179, 180, 181, 270, 366]) {
  test(`FreeBusy ${days}-day coverage is contiguous and bounded across DST`, async () => {
    const range = createCalendarQueryRange('2026-03-01', addDays('2026-03-01', days - 1), 'America/New_York');
    const windows = [];
    const client = createCalendarFreeBusyClient(async (_url, options) => {
      const body = JSON.parse(options.body); windows.push(body);
      assert.deepEqual(body.items, [{ id: 'primary' }]);
      return Response.json(payload([]));
    });
    assert.deepEqual(await client.query('fixture-token', range), []);
    assert.equal(windows.length, Math.ceil((Date.parse(range.timeMax) - Date.parse(range.timeMin)) / (90 * 86400_000)));
    assert.equal(windows[0].timeMin, range.timeMin); assert.equal(windows.at(-1).timeMax, range.timeMax);
    windows.forEach((window, index) => {
      assert.ok(Date.parse(window.timeMax) - Date.parse(window.timeMin) <= 90 * 86400_000);
      assert.ok(Date.parse(window.timeMax) > Date.parse(window.timeMin));
      if (index) assert.equal(window.timeMin, windows[index - 1].timeMax);
    });
  });
}

for (const [label, interval] of [
  ['empty', { start: '', end: '' }],
  ['date only', { start: '2026-10-26', end: '2026-10-27' }],
  ['impossible day', { start: '2026-02-30T10:00:00Z', end: '2026-03-03T10:00:00Z' }],
  ['invalid time', { start: '2026-10-26T24:00:00Z', end: '2026-10-28T00:00:00Z' }],
  ['reversed', { start: '2026-10-26T12:00:00Z', end: '2026-10-26T11:00:00Z' }],
  ['zero duration', { start: '2026-10-26T12:00:00Z', end: '2026-10-26T12:00:00Z' }],
  ['missing', {}], ['null', null], ['nonstring', { start: 0, end: 1 }],
]) {
  test(`FreeBusy rejects ${label} interval as a retryable invalid response`, async () => {
    const client = createCalendarFreeBusyClient(async () => Response.json(payload([interval])));
    await assert.rejects(client.query('fixture-token', createCalendarQueryRange('2026-10-26', '2026-10-26', 'UTC')),
      (error) => error instanceof CalendarFreeBusyError && error.status === 502 && error.code === 'calendar_invalid_response');
  });
}

for (const reason of ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded']) {
  test(`FreeBusy ${reason} keeps retry timing instead of permanently stopping Calendar`, async () => {
    const client = createCalendarFreeBusyClient(async () => Response.json({ error: { errors: [{ reason }] } },
      { status: 403, headers: { 'Retry-After': '7200' } }));
    await assert.rejects(client.query('fixture-token', createCalendarQueryRange('2026-10-26', '2026-10-26', 'UTC')),
      (error) => error instanceof CalendarFreeBusyError && error.code === 'calendar_rate_limited' && error.retryAfter === '7200');
  });
}

for (const [label, value] of [
  ['missing root', null], ['missing calendars', {}], ['missing primary', { calendars: {} }],
  ['missing busy', { calendars: { primary: {} } }], ['nonarray busy', payload({})],
  ['nonarray item errors', { calendars: { primary: { busy: [], errors: 'failed' } } }],
  ['malformed item error', { calendars: { primary: { busy: [], errors: [null] } } }],
  ['wrong response start', { ...payload([]), timeMin: '2026-10-25T00:00:00Z' }],
  ['wrong response end', { ...payload([]), timeMax: '2026-10-30T00:00:00Z' }],
]) {
  test(`FreeBusy never converts ${label} to an empty free calendar`, async () => {
    const client = createCalendarFreeBusyClient(async () => Response.json(value));
    await assert.rejects(client.query('fixture-token', createCalendarQueryRange('2026-10-26', '2026-10-26', 'UTC')),
      (error) => error instanceof CalendarFreeBusyError && error.status === 502);
  });
}

test('FreeBusy accepts equivalent response offsets and discards unrelated calendars and event metadata', async () => {
  const range = createCalendarQueryRange('2026-10-26', '2026-10-26', 'UTC');
  const client = createCalendarFreeBusyClient(async () => Response.json({ timeMin: '2026-10-26T09:00:00+09:00', timeMax: '2026-10-27T09:00:00+09:00',
    calendars: { primary: { busy: [{ start: '2026-10-26T10:00:00Z', end: '2026-10-26T11:00:00Z', title: 'private-canary' }] }, unrelated: { busy: [{ start: range.timeMin, end: range.timeMax }] } } }));
  assert.deepEqual(await client.query('fixture-token', range), [{ start: '2026-10-26T10:00:00Z', end: '2026-10-26T11:00:00Z' }]);
});

test('calendar minute rounding occurs after union and splitting at midnight without mutating source data', () => {
  const range = createCalendarQueryRange('2026-10-26', '2026-10-27', 'UTC');
  const busy = Object.freeze([
    Object.freeze({ start: '2026-10-26T10:00:00.100Z', end: '2026-10-26T10:00:00.200Z' }),
    Object.freeze({ start: '2026-10-26T10:01:00.100Z', end: '2026-10-26T10:01:00.200Z' }),
    Object.freeze({ start: '2026-10-26T23:59:59.900Z', end: '2026-10-27T00:00:00.100Z' }),
  ]);
  assert.deepEqual(aggregateBusyMinutes(busy, range, stamp).map(({ busyMinutes }) => busyMinutes), [1, 1]);
});

function random(seed) {
  let state = seed;
  return (max) => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state % max; };
}

const zones = ['UTC', 'Asia/Tokyo', 'Asia/Kathmandu', 'Pacific/Chatham', 'Australia/Lord_Howe', 'America/New_York', 'Europe/Berlin', 'Africa/Casablanca', 'Pacific/Kiritimati', 'America/St_Johns'];
for (const timeZone of zones) for (const from of ['2026-03-07', '2026-10-24', '2026-10-31', '2026-04-04', '2026-02-14', '2026-03-21', '2026-12-31', '2028-02-28']) {
  test(`calendar aggregation agrees with an independent minute-union oracle: ${timeZone} ${from} (64 seeds)`, () => {
    const through = addDays(from, 2);
    const range = createCalendarQueryRange(from, through, timeZone);
    const minimum = Date.parse(range.timeMin); const maximum = Date.parse(range.timeMax);
    const minutes = (maximum - minimum) / 60_000;
    // Events and availability use the same packaged tzdb on both mobile OSes.
    // The host ICU can have an older law set (e.g. 2026a versus bundled 2026e).
    // Independent oracle walks real instants and labels each minute; it does not
    // reuse the implementation's transition-boundary selection or interval merging.
    const dateIndex = Array.from({ length: minutes }, (_, minute) => {
      const date = moment.tz(minimum + minute * 60_000, timeZone).format('YYYY-MM-DD');
      return [from, addDays(from, 1), through].indexOf(date);
    });
    assert.ok(dateIndex.every((index) => index >= 0));
    for (let seed = 1; seed <= 64; seed++) {
      const next = random(seed); const covered = new Uint8Array(minutes); const busy = [];
      for (let count = 0; count < 40; count++) {
        const start = next(minutes + 240) - 120;
        const end = start + 1 + next(360);
        busy.push({ start: new Date(minimum + start * 60_000).toISOString(), end: new Date(minimum + end * 60_000).toISOString() });
        for (let minute = Math.max(0, start); minute < Math.min(minutes, end); minute++) covered[minute] = 1;
      }
      // Duplicates, shuffled input, overlaps and clipping must not add minutes.
      busy.push(busy[0], busy[1]); busy.reverse();
      const expected = [0, 0, 0];
      covered.forEach((value, minute) => { expected[dateIndex[minute]] += value; });
      assert.deepEqual(aggregateBusyMinutes(busy, range, stamp).map((day) => day.busyMinutes), expected, `seed=${seed}`);
    }
  });
}
