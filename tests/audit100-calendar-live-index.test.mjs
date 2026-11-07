import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from './helpers/sqlite.mjs';
import {writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {newEventDraft} from '../src/domain/calendar/events.ts';
const {initializeLocalDatabase}=await import('../src/platform/storage/repository.ts');
const {readCalendarEventRows}=await import('../src/platform/storage/calendar-event-rows.ts');
test('audit100 visible Calendar reads use the live-row index after many retained deletion tombstones without changing visible events',async t=>{
 const h=createDatabase();t.after(()=>h.connection.close());await initializeLocalDatabase(h.database);
 const insert=h.connection.prepare('INSERT INTO calendar_events VALUES(?,?,1,?)');h.connection.exec('BEGIN');for(let i=0;i<40000;i++)insert.run(`old.${String(i).padStart(5,'0')}`,'{}',1);for(let i=0;i<20;i++)insert.run(`visible.${i}`,JSON.stringify({...newEventDraft('2026-11-07','Asia/Tokyo'),title:`visible ${i}`,allDay:true}),0);h.connection.exec('COMMIT');
 const get=h.database.getAllAsync;let query;h.database.getAllAsync=async(sql,...args)=>{if(sql.startsWith('SELECT e.* FROM calendar_events'))query={sql,args};return get(sql,...args);};
 const first=await readCalendarEventRows(h.database);assert.equal(first.events.length,20);assert.ok(first.events.every(row=>row.id.startsWith('visible.')));
 const plans=h.connection.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.args);const durations=[];for(let i=0;i<8;i++){const start=performance.now();h.connection.prepare(query.sql).all(...query.args);durations.push(performance.now()-start);}console.info(JSON.stringify({calendarRows:40020,visibleRows:20,queryPlan:plans.map(row=>row.detail),medianMs:durations.sort((a,b)=>a-b)[4]}));
 assert.ok(plans.some(row=>/SEARCH e .*deleted/u.test(row.detail)),`visible lookup plan: ${plans.map(row=>row.detail).join(';')}`);
});
