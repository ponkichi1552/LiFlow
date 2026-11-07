import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarOccurrenceAt, findGoogleCalendarInstance } from '../src/features/calendar/google-instance.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';
const series={...newEventDraft('2026-11-04','Asia/Tokyo'),title:'Multi-day',allDay:true,endDate:'2026-11-05',recurrence:'daily'};
test('exact anchors reject an overlapping previous occurrence and preserve the requested multi-day dates', async()=>{
  const value=calendarOccurrenceAt(series,'parent','2026-11-06'); assert.equal(value.startDate,'2026-11-06'); assert.equal(value.endDate,'2026-11-07');
  assert.equal(calendarOccurrenceAt({...series,recurrence:'weekly'},'parent','2026-11-05'),null);
  let request;const remote={id:'instance',recurringEventId:'parent',originalStartTime:{date:'2026-11-06'}};
  const found=await findGoogleCalendarInstance({api:{instances:async(_cal,_parent,query)=>{request=query;return{items:[remote]};}},request:fn=>fn(),calendarId:'calendar',parentId:'parent',anchorDate:'2026-11-06',series});
  assert.equal(found,remote);assert.equal(request.originalStart,'2026-11-06');
});
