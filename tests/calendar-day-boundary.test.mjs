import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { localDayBoundary } = await import('../src/features/calendar/local-day-boundary.ts');
const { createCalendarQueryRange, aggregateBusyMinutes } = await import('../src/features/google-sync/calendar-availability.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');

function nativeBoundary(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const civil = at => {
    const parts = formatter.formatToParts(at); const value = type => parts.find(part => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  };
  let low = Date.parse(`${date}T00:00Z`) - 36 * 3600000; let high = low + 72 * 3600000;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (civil(middle) < date) low = middle + 1; else high = middle; }
  return low;
}

test('private Calendar day boundaries match independent native civil-date searches across regional offsets and DST', () => {
  const zones = ['UTC', 'Asia/Tokyo', 'Asia/Kathmandu', 'Asia/Kolkata', 'America/New_York', 'America/Los_Angeles',
    'America/Havana', 'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Pacific/Apia', 'Africa/Casablanca'];
  for (const zone of zones) for (const date of ['2024-01-01', '2024-03-10', '2024-03-31', '2024-04-07', '2024-10-06', '2024-10-27', '2024-11-03', '2024-12-31']) {
    assert.equal(localDayBoundary(date, zone), nativeBoundary(date, zone), `${zone} ${date}`);
    assert.equal(localDayBoundary(date, zone), nativeBoundary(date, zone), 'repeated reads preserve that exact boundary');
  }
});

test('midnight folds partial-hour gaps and skipped dates never invent or lose available Calendar time', () => {
  assert.equal(new Date(localDayBoundary('1986-01-01', 'Asia/Kathmandu')).toISOString(), '1985-12-31T18:30:00.000Z');
  assert.equal(new Date(localDayBoundary('2015-11-01', 'America/Havana')).toISOString(), '2015-11-01T04:00:00.000Z');
  assert.equal(localDayBoundary('2011-12-30', 'Pacific/Apia'), localDayBoundary('2011-12-31', 'Pacific/Apia'));
  for (const [zone, date, minutes] of [['America/New_York', '2026-03-08', 1380], ['America/New_York', '2026-11-01', 1500],
    ['Australia/Lord_Howe', '2024-10-06', 1410], ['Asia/Kathmandu', '1986-01-01', 1425], ['Pacific/Apia', '2011-12-30', 0]]) {
    const range = createCalendarQueryRange(date, date, zone);
    const rows = aggregateBusyMinutes([{ start: range.timeMin, end: range.timeMax === range.timeMin ? new Date(Date.parse(range.timeMax) + 1).toISOString() : range.timeMax }], range, '2026-11-05T00:00:00.000Z');
    assert.equal(rows[0].busyMinutes, minutes, `${zone} ${date}`);
  }
});

test('a cold 181-day private Calendar horizon requires no native Intl format-to-parts loops and invalid inputs stay rejected', () => {
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  Intl.DateTimeFormat.prototype.formatToParts = () => { throw new Error('unexpected native date search'); };
  try {
    const from = '2031-01-01'; const through = addDays(from, 180); const range = createCalendarQueryRange(from, through, 'America/New_York');
    const days = aggregateBusyMinutes([{ start: range.timeMin, end: range.timeMax }], range, '2031-01-01T00:00Z');
    assert.equal(days.length, 181); assert.equal(days[0].localDate, from); assert.equal(days.at(-1).localDate, through);
    assert.equal(days.reduce((sum, day) => sum + day.busyMinutes, 0), (Date.parse(range.timeMax) - Date.parse(range.timeMin)) / 60000);
    for (const date of ['2026-02-30', '2026-13-01', 'not-a-date']) assert.throws(() => localDayBoundary(date, 'UTC'));
    assert.throws(() => localDayBoundary('2026-11-05', 'Invalid/Zone'));
    assert.throws(() => createCalendarQueryRange('2026-11-06', '2026-11-05', 'UTC'));
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original; }
});
