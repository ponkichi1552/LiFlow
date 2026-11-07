import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from './helpers/sqlite.mjs';
const repo=await import('../src/platform/storage/repository.ts');
const {addDays}=await import('../src/domain/scheduling/local-date.ts');
test('audit100 a Calendar aggregate replacement writes 181 covered days in bounded SQLite chunks and rolls back a failed chunk',async t=>{
 const h=createDatabase();t.after(()=>h.connection.close());await repo.initializeLocalDatabase(h.database);
 const days=Array.from({length:181},(_,i)=>({localDate:addDays('2026-11-07',i),busyMinutes:i,timeZone:'Asia/Tokyo',fetchedAt:'2026-11-07T12:00:00.000Z'}));
 const run=h.database.runAsync;let inserts=0;h.database.runAsync=async(sql,...args)=>{if(sql.startsWith('INSERT INTO calendar_availability_days'))inserts++;return run(sql,...args);};
 await repo.replaceCalendarAvailabilityDays(h.database,days);assert.deepEqual(await repo.listCalendarAvailabilityDays(h.database),days);assert.ok(inserts<=3,`aggregate inserts: ${inserts}`);
 let chunks=0;h.database.runAsync=async(sql,...args)=>{if(sql.startsWith('INSERT INTO calendar_availability_days')&&++chunks===2)throw Error('interrupted chunk');return run(sql,...args);};
 await assert.rejects(repo.replaceCalendarAvailabilityDays(h.database,days.map(row=>({...row,busyMinutes:500}))));assert.deepEqual(await repo.listCalendarAvailabilityDays(h.database),days);
});
