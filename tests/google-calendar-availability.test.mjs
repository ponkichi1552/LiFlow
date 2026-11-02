import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/typescript-loader.mjs';
const { createCalendarQueryRange, aggregateBusyMinutes, freshCalendarAvailability, shouldRefreshCalendar, CALENDAR_AVAILABILITY_MAX_AGE_MS } =
  await import('../src/features/google-sync/calendar-availability.ts');
const { busyMinutesToBucket, calendarPenaltyForChore } = await import('../src/domain/scheduling/calendar-penalty.ts');
const now = new Date('2026-10-25T03:00:00.000Z');
const stamp = now.toISOString();
const day = '2026-10-25';
const utcRange = createCalendarQueryRange(day, '2026-10-27', 'UTC');
const interval = (start, end) => ({ start, end });
const utc = (date, time) => `2026-10-${date}T${time}:00.000Z`;
const cases = [
  ['single', [interval(utc('25','10:00'), utc('25','12:00'))], [120,0,0]],
  ['overlap', [interval(utc('25','10:00'),utc('25','12:00')),interval(utc('25','11:30'),utc('25','13:00'))], [180,0,0]],
  ['contained overlap', [interval(utc('25','10:00'),utc('25','13:00')),interval(utc('25','11:00'),utc('25','12:00'))], [180,0,0]],
  ['adjacent', [interval(utc('25','10:00'),utc('25','11:00')),interval(utc('25','11:00'),utc('25','12:00'))], [120,0,0]],
  ['cross day', [interval(utc('25','23:00'),utc('26','02:00'))], [60,120,0]],
  ['multiple days', [interval(utc('25','23:00'),utc('27','02:00'))], [60,1440,120]],
  ['range clipping', [interval(utc('24','23:00'),utc('25','02:00')),interval(utc('27','23:00'),utc('28','02:00'))], [120,0,60]],
  ['all day', [interval(utc('25','00:00'),utc('26','00:00'))], [1440,0,0]],
  ['empty', [], [0,0,0]],
];
for (const [name,busy,expected] of cases) test('calendar aggregation: '+name, () => {
  assert.deepEqual(aggregateBusyMinutes(busy,utcRange,stamp).map((d)=>d.busyMinutes),expected);
});
test('calendar uses IANA local date boundaries rather than a fixed offset', () => {
  const range=createCalendarQueryRange(day,day,'Asia/Tokyo');
  assert.equal(range.timeMin,'2026-10-24T15:00:00.000Z');
  assert.equal(range.timeMax,'2026-10-25T15:00:00.000Z');
  assert.equal(aggregateBusyMinutes([interval('2026-10-24T23:00:00Z','2026-10-25T01:00:00Z')],range,stamp)[0].busyMinutes,120);
});
for (const [name,date,start,end,expected] of [
  ['spring forward','2026-03-08','2026-03-08T05:00:00.000Z','2026-03-09T04:00:00.000Z',1380],
  ['fall back','2026-11-01','2026-11-01T04:00:00.000Z','2026-11-02T05:00:00.000Z',1500],
]) test('calendar DST '+name, () => {
  const range=createCalendarQueryRange(date,date,'America/New_York');
  assert.equal(range.timeMin,start);assert.equal(range.timeMax,end);
  assert.equal(aggregateBusyMinutes([interval(start,end)],range,stamp)[0].busyMinutes,expected);
});
test('invalid RFC3339 and nonpositive intervals are never repaired', () => {
  for(const busy of [
    interval('not-a-date',utc('25','10:00')),
    interval('2026-02-30T10:00:00Z',utc('25','10:00')),
    interval('2026-10-25',utc('25','10:00')),
    interval(utc('25','10:00'),utc('25','10:00')),
    interval(utc('25','11:00'),utc('25','10:00')),
  ]) assert.throws(()=>aggregateBusyMinutes([busy],utcRange,stamp));
  assert.throws(()=>createCalendarQueryRange(day,day,'Invalid/Zone'));
});
test('freshness excludes disabled, stale, future, and wrong-time-zone cache', () => {
  const state={enabled:true};
  const days=[{localDate:day,busyMinutes:500,timeZone:'Asia/Tokyo',fetchedAt:stamp}];
  assert.deepEqual(freshCalendarAvailability(state,days,now,'Asia/Tokyo'),{[day]:{busyMinutes:500}});
  for(const hours of [36,36+1/3600000]){
    const result=freshCalendarAvailability(state,days,new Date(now.getTime()+hours*3600000),'Asia/Tokyo');
    assert.equal(Boolean(result),hours===36);
  }
  assert.equal(freshCalendarAvailability({enabled:false},days,now,'Asia/Tokyo'),undefined);
  assert.equal(freshCalendarAvailability(state,days,new Date(now.getTime()-1),'Asia/Tokyo'),undefined);
  assert.equal(freshCalendarAvailability(state,days,now,'America/New_York'),undefined);
  assert.equal(CALENDAR_AVAILABILITY_MAX_AGE_MS,36*3600000);
});
test('calendar refresh policy preserves 24h, hourly retry, disabled and permission states', () => {
  const state={enabled:true,status:'idle',lastSuccessfulSyncAt:stamp};
  assert.equal(shouldRefreshCalendar(state,new Date(now.getTime()+24*3600000-1)),false);
  assert.equal(shouldRefreshCalendar(state,new Date(now.getTime()+24*3600000)),true);
  assert.equal(shouldRefreshCalendar({...state,status:'retryPending',nextRetryAt:stamp},now),true);
  assert.equal(shouldRefreshCalendar({...state,status:'retryPending',nextRetryAt:new Date(now.getTime()+1).toISOString()},now),false);
  assert.equal(shouldRefreshCalendar({...state,status:'permissionRequired'},now),false);
  assert.equal(shouldRefreshCalendar({...state,status:'permissionRequired'},now,true),true);
  assert.equal(shouldRefreshCalendar({...state,enabled:false},now,true),false);
});
test('busy buckets and load equivalents have explicit boundaries', () => {
  assert.deepEqual([0,120,121,300,301,480,481,1440].map(busyMinutesToBucket),[0,0,1,1,2,2,3,3]);
  assert.deepEqual(['light','normal','heavy'].map((load)=>calendarPenaltyForChore(load,481)),[3,6,9]);
});

test('repeated Calendar availability keeps exact regional day boundaries without repeating Intl binary searches', () => {
  const original = Intl.DateTimeFormat.prototype.formatToParts; let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) { calls++; return original.apply(this, args); };
  try {
    const first = createCalendarQueryRange('2011-12-29', '2012-01-03', 'Pacific/Apia');
    const whole = [{ start: first.timeMin, end: first.timeMax }];
    const a = aggregateBusyMinutes(whole, first, stamp); const warmed = calls; assert.ok(warmed > 0);
    const second = createCalendarQueryRange('2011-12-29', '2012-01-03', 'Pacific/Apia');
    assert.deepEqual(aggregateBusyMinutes(whole, second, stamp), a); assert.equal(calls, warmed);
    assert.equal(a.find(row => row.localDate === '2011-12-30').busyMinutes, 0, 'a skipped civil day is not invented');
    const utc = createCalendarQueryRange('2011-12-29', '2012-01-03', 'UTC');
    assert.notEqual(utc.timeMin, first.timeMin); assert.ok(calls > warmed, 'another timezone must not reuse these boundaries');
    assert.throws(() => createCalendarQueryRange('2011-12-32', '2012-01-03', 'Pacific/Apia'));
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original; }
});
