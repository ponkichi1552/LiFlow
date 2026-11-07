import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {googleImportedEvent} from '../src/features/calendar/google-event-import.ts';
import {googleOriginalDate} from '../src/features/calendar/google-instance.ts';
import {calendarEventsInTimeZone,newEventDraft} from '../src/domain/calendar/events.ts';
import {moveCalendarStart} from '../src/features/calendar/event-editing.ts';
test('audit100 Calendar import display edits and instance anchors use the same pinned zone rules as scheduling on older OS timezone databases',()=>{
 const zone='America/Winnipeg';const remote={id:'clock',summary:'clock',start:{dateTime:'2026-11-07T12:00:00Z',timeZone:zone},end:{dateTime:'2026-11-07T13:00:00Z',timeZone:zone}};
 const imported=googleImportedEvent(remote,'private');assert.equal(imported.startMinute,420);assert.equal(imported.endMinute,480);
 assert.equal(googleOriginalDate({originalStartTime:{dateTime:'2026-11-07T05:30:00Z'}},zone),'2026-11-07');
 const event={...newEventDraft('2026-11-07','UTC'),title:'clock',id:'c:0',eventId:'c',anchorDate:'2026-11-07',eventRevision:1,exceptionRevision:0,startMinute:720,endMinute:780};
 const projected=calendarEventsInTimeZone([event],zone)[0];assert.equal(projected.startMinute,420);assert.equal(projected.endMinute,480);
 const moved=moveCalendarStart({...newEventDraft('2026-11-07',zone),title:'clock',startMinute:420,endMinute:480},{startMinute:540});assert.equal(moved.endMinute,600);
});
