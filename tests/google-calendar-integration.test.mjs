import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers/typescript-loader.mjs';
import { createIntegration, repository, now, today } from './helpers/google-sync-integration.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const { migrateLocalDatabase }=await import('../src/platform/storage/migrations.ts');
const { createCalendarQueryRange, aggregateBusyMinutes, getDeviceTimeZone, CalendarPermissionRequiredError }=
 await import('../src/features/google-sync/calendar-availability.ts');
const { refreshCalendarWithDependencies }=await import('../src/features/google-sync/calendar-coordinator.ts');
const { CalendarFreeBusyError }=await import('../src/platform/google-tasks/google-calendar-freebusy-client.ts');
const { syncGoogleTasksWithDependencies }=await import('../src/features/google-sync/coordinator.ts');
const { configureGoogleCalendarAvailability }=await import('../src/features/google-sync/calendar-settings.ts');
const range=()=>{const {from,through}=repository.plannerGenerationRange(today);return createCalendarQueryRange(from,through,getDeviceTimeZone());};
function calendarPort(h,busy=[]){
 let calls=0;let regenerations=0;
 const port={
  loadState:()=>repository.loadCalendarAvailabilityState(h.database),
  saveState:(s)=>repository.saveCalendarAvailabilityState(h.database,s),
  commitSuccess:(days,s)=>repository.commitCalendarAvailabilitySuccess(h.database,days,s),
  getAccessToken:async()=> 'fixture-token',
  client:{query:async()=>{calls++;return busy;}},
  readPlanningSignatures:()=>repository.readCalendarPlanningSignatures(h.database,now,range().timeZone),
  regeneratePlanner:async()=>{
   regenerations++;
   const before=await repository.listEntriesForGoogleSync(h.database,today);
   await repository.loadPlannerSnapshot(h.database,today,now);
   const after=await repository.listEntriesForGoogleSync(h.database,today);
   return JSON.stringify(before)!==JSON.stringify(after);
  },
 };
 h.dependencies.refreshCalendar=(options)=>refreshCalendarWithDependencies(port,{...options,range:range()});
 return {port,calls:()=>calls,regenerations:()=>regenerations,refresh:(force=false)=>refreshCalendarWithDependencies(port,{now,range:range(),force})};
}
test('fresh, unchanged and same-bucket Calendar data do not regenerate the Planner', async () => {
 const h=await createIntegration({cycleDays:7,previousDate:'2026-10-20'});
 try {
  await repository.setCalendarAvailabilityEnabled(h.database,true,now);
  const oneDay=createCalendarQueryRange('2026-10-27','2026-10-27',range().timeZone);
  const intervals=[{start:oneDay.timeMin,end:new Date(Date.parse(oneDay.timeMin)+270*60_000).toISOString()}];
  const calendar=calendarPort(h,intervals);
  await calendar.refresh(true);
  assert.equal(calendar.regenerations(),1);
  await calendar.refresh();
  assert.equal(calendar.calls(),1);
  assert.equal(calendar.regenerations(),1);
  intervals[0].end=new Date(Date.parse(oneDay.timeMin)+280*60_000).toISOString();
  await calendar.refresh(true);
  assert.equal(calendar.calls(),2);
  assert.equal(calendar.regenerations(),1);
 } finally {h.connection.close();}
});

test('expiry removes Calendar influence once even when refreshing requires permission', async () => {
 const h=await createIntegration({cycleDays:7,previousDate:'2026-10-20'});
 try {
  await repository.setCalendarAvailabilityEnabled(h.database,true,now);
  const oneDay=createCalendarQueryRange('2026-10-27','2026-10-27',range().timeZone);
  const calendar=calendarPort(h,[{start:oneDay.timeMin,end:new Date(Date.parse(oneDay.timeMin)+270*60_000).toISOString()}]);
  await calendar.refresh(true);
  h.connection.exec("UPDATE calendar_availability_days SET fetched_at='2026-10-20T00:00:00.000Z'");
  await repository.saveCalendarAvailabilityState(h.database,{...(await repository.loadCalendarAvailabilityState(h.database)),status:'permissionRequired'});
  await calendar.refresh();await calendar.refresh();
  assert.equal(calendar.calls(),1);
  assert.equal(calendar.regenerations(),2);
 } finally {h.connection.close();}
});
test('v14 upgrade and repeated migration preserve mappings and Google completion history',async()=>{
 const h=await createIntegration();
 try{
  const entry=h.entries[0];const task=[...h.tasks.values()][0];task.status='completed';task.completed=now.toISOString();
  await h.sync();const history=h.history();const links=await repository.listGoogleTaskLinks(h.database);
  h.connection.exec('DROP TABLE calendar_availability_days; DROP TABLE calendar_availability_state; PRAGMA user_version=14;');
  await migrateLocalDatabase(h.database);await migrateLocalDatabase(h.database);
  assert.equal(h.connection.prepare('PRAGMA user_version').get().user_version,29);
  assert.deepEqual(h.history(),history);assert.deepEqual(await repository.listGoogleTaskLinks(h.database),links);
  assert.equal(h.history().filter((c)=>c.schedule_entry_id===entry.id).length,1);
  assert.equal(h.connection.prepare('PRAGMA foreign_key_check').all().length,0);
  const columns=h.connection.prepare('PRAGMA table_info(calendar_availability_days)').all().map((r)=>r.name);
  assert.deepEqual(columns,['household_id','local_date','busy_minutes','time_zone','fetched_at']);
  assert.ok(h.connection.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_calendar_availability_freshness'").get());
 }finally{h.connection.close();}
});
test('Calendar aggregate replace is atomic and a failure keeps both cache and success state',async()=>{
 const h=await createIntegration();
 try{
  await repository.setCalendarAvailabilityEnabled(h.database,true,now);
  const days=aggregateBusyMinutes([],range(),now.toISOString());
  await repository.commitCalendarAvailabilitySuccess(h.database,days,{...(await repository.loadCalendarAvailabilityState(h.database)),lastSuccessfulSyncAt:now.toISOString()});
  const before=await repository.listCalendarAvailabilityDays(h.database);
  const state=await repository.loadCalendarAvailabilityState(h.database);
  const run=h.database.runAsync;let inserts=0;
  h.database.runAsync=async(sql,...params)=>{if(sql.startsWith('INSERT INTO calendar_availability_days')&&++inserts===2)throw new Error('fixture write failure');return run(sql,...params);};
  await assert.rejects(repository.commitCalendarAvailabilitySuccess(h.database,days.map((d)=>({...d,busyMinutes:60})),{...state,lastSuccessfulSyncAt:'2026-10-26T03:00:00.000Z'}));
  h.database.runAsync=run;
  assert.deepEqual(await repository.listCalendarAvailabilityDays(h.database),before);
  assert.deepEqual(await repository.loadCalendarAvailabilityState(h.database),state);
  await assert.rejects(repository.replaceCalendarAvailabilityDays(h.database,[days[0],days[0]]));
  assert.deepEqual(await repository.listCalendarAvailabilityDays(h.database),before);
  await repository.setCalendarAvailabilityEnabled(h.database,false,now);
  assert.deepEqual(await repository.listCalendarAvailabilityDays(h.database),[]);
  assert.equal(await repository.getFreshCalendarAvailabilityDays(h.database,now),undefined);
 }finally{h.connection.close();}
});
test('Calendar reschedule preserves schedule and Google task IDs and patches only due',async()=>{
 const h=await createIntegration({cycleDays:7,previousDate:'2026-10-20',choreOverrides:{load:'heavy',maxShiftDays:2}});
 try{
  const original=h.entries[0];assert.equal(original.suggestedDate,'2026-10-27');
  const link=(await repository.listGoogleTaskLinks(h.database)).find((l)=>l.scheduleEntryId===original.id);
  await repository.setCalendarAvailabilityEnabled(h.database,true,now);
  const rangeValue=range();
  const dateRange=createCalendarQueryRange('2026-10-27','2026-10-27',rangeValue.timeZone);
  const calendar=calendarPort(h,[{start:dateRange.timeMin,end:dateRange.timeMax}]);
  const result=await h.sync();assert.equal(result.kind,'success');assert.equal(calendar.calls(),1);
  const snapshot=await h.snapshot();assert.equal(snapshot.scheduleEntries.find((e)=>e.id===original.id).suggestedDate,'2026-10-26');
  const updated=(await repository.listGoogleTaskLinks(h.database)).find((l)=>l.scheduleEntryId===original.id);
  assert.equal(updated.googleTaskId,link.googleTaskId);
  const writes=h.calls.filter((c)=>c.method!=='GET');
  assert.deepEqual(writes.map((w)=>w.method),['PATCH']);
  assert.match(writes[0].body.notes, /^LiFlow personal occurrence: [a-f0-9]{64}$/u);
  assert.deepEqual({...writes[0].body,notes:undefined},{due:'2026-10-26T00:00:00.000Z',notes:undefined});
  assert.equal((await calendar.refresh()).kind,'skipped');assert.equal(calendar.calls(),1);
  await repository.setCalendarAvailabilityEnabled(h.database,false,now);
  await h.snapshot();h.calls.length=0;await h.sync();
  assert.equal(calendar.calls(),1);
  assert.equal(h.tasks.get(link.googleTaskId).due,'2026-10-27T00:00:00.000Z');
  assert.equal(h.calls.filter((c)=>c.method!=='GET').length,1);
 }finally{h.connection.close();}
});
for(const [label,error,status]of[
 ['network',new TypeError('fixture network'),'retryPending'],
 ['timeout',new DOMException('fixture timeout','AbortError'),'retryPending'],
 ['native operation unavailable',Object.assign(new Error('fixture unavailable'),{code:'IN_PROGRESS'}),'retryPending'],
 ['server',new CalendarFreeBusyError(503,'calendar_http_503'),'retryPending'],
 ['rate limit',new CalendarFreeBusyError(429,'calendar_http_429','7200'),'retryPending'],
 ['403 rate limit',new CalendarFreeBusyError(403,'calendar_rate_limited','7200'),'retryPending'],
 ['permission',new CalendarPermissionRequiredError(),'permissionRequired'],
 ['API disabled',new CalendarFreeBusyError(403,'calendar_api_not_enabled'),'error'],
 ['permanent',new CalendarFreeBusyError(400,'calendar_http_400'),'error'],
]){
 test('Calendar '+label+' failure preserves successful Tasks sync and completion import',async()=>{
  const h=await createIntegration();
  try{
   await repository.setCalendarAvailabilityEnabled(h.database,true,now);
   const calendar=calendarPort(h);calendar.port.client.query=async()=>{throw error;};
   const task=[...h.tasks.values()][0];task.status='completed';task.completed=now.toISOString();task.hidden=true;
   const result=await h.sync();assert.equal(result.kind,'success');assert.equal(result.imported,1);
   assert.equal((await repository.loadGoogleSyncState(h.database)).status,'idle');
   const state=await repository.loadCalendarAvailabilityState(h.database);
   assert.equal(state.status,status);assert.equal(h.history()[0].source,'googleTasks');
   if(status==='retryPending')assert.equal(Date.parse(state.nextRetryAt)-now.getTime(),label.includes('rate limit')?7200000:3600000);
   assert.equal((await repository.listCalendarAvailabilityDays(h.database)).length,0);
  }finally{h.connection.close();}
 });
}
test('disabled and retry-before-deadline Calendar calls are zero and fresh cache survives failure',async()=>{
 const h=await createIntegration();
 try{
  const calendar=calendarPort(h);
  assert.equal((await calendar.refresh(true)).kind,'disabled');assert.equal(calendar.calls(),0);
  await repository.setCalendarAvailabilityEnabled(h.database,true,now);
  await calendar.refresh(true);assert.equal(calendar.calls(),1);
  const cache=await repository.listCalendarAvailabilityDays(h.database);
  const state=await repository.loadCalendarAvailabilityState(h.database);
  await repository.saveCalendarAvailabilityState(h.database,{...state,status:'retryPending',nextRetryAt:new Date(now.getTime()+3600000).toISOString()});
  await calendar.refresh();assert.equal(calendar.calls(),1);
  calendar.port.client.query=async()=>{throw new TypeError('offline');};
  await calendar.refresh(true);
  assert.deepEqual(await repository.listCalendarAvailabilityDays(h.database),cache);
  assert.ok(await repository.getFreshCalendarAvailabilityDays(h.database,now));
  assert.equal(await repository.getFreshCalendarAvailabilityDays(h.database,new Date(now.getTime()+36*3600000+1)),undefined);
 }finally{h.connection.close();}
});
test('completion regeneration uses fresh Calendar cache and stale cache produces the original schedule',async()=>{
 const h=await createIntegration({cycleDays:7,previousDate:'2026-10-18',choreOverrides:{load:'heavy',maxShiftDays:2}});
 try{
  await repository.setCalendarAvailabilityEnabled(h.database,true,now);
  const full=range();const busy=createCalendarQueryRange('2026-11-01','2026-11-01',full.timeZone);
  await repository.replaceCalendarAvailabilityDays(h.database,aggregateBusyMinutes([{start:busy.timeMin,end:busy.timeMax}],full,now.toISOString()));
  const link=(await repository.listGoogleTaskLinks(h.database))[0];
  await repository.importGoogleTaskCompletions(h.database,[{...link,completedAt:now.toISOString()}],today,now);
  const fresh=await repository.loadPlannerSnapshot(h.database,today,now);
  assert.ok(fresh.externalAvailabilityByDate);
  assert.equal(fresh.scheduleEntries.filter((e)=>e.choreId===h.chore.id)[0].suggestedDate,'2026-10-31');
  const stale=await repository.loadPlannerSnapshot(h.database,today,new Date(now.getTime()+36*3600000+1));
  assert.equal(stale.externalAvailabilityByDate,undefined);
  assert.equal(stale.scheduleEntries.filter((e)=>e.choreId===h.chore.id)[0].suggestedDate,'2026-11-01');
 }finally{h.connection.close();}
});
test('settings changes and manual/foreground sync share one operation queue',async()=>{
 const h=await createIntegration();
 try{
  let release;let started;const entered=new Promise((r)=>{started=r;});
  const wait=new Promise((r)=>{release=r;});
  const settings=configureGoogleCalendarAvailability(h.database,true,async()=>{started();await wait;});
  await entered;
  const calendar=calendarPort(h);
  const first=syncGoogleTasksWithDependencies(h.dependencies,{now,force:true});
  const second=syncGoogleTasksWithDependencies(h.dependencies,{now,force:true});
  await new Promise((r)=>setImmediate(r));assert.equal(h.calls.length,0);
  release();assert.equal(await settings,true);
  assert.deepEqual(await first,await second);assert.equal(calendar.calls(),1);
  const denied=await configureGoogleCalendarAvailability(h.database,true,async()=>{throw new Error('denied');});
  assert.equal(denied,false);assert.equal((await repository.loadCalendarAvailabilityState(h.database)).status,'permissionRequired');
  assert.equal((await repository.loadGoogleSyncState(h.database)).status,'idle');
 }finally{h.connection.close();}
});
test('Calendar settings and aggregate cache persist across database close/reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'calendar-cache-'));const file=join(dir,'planner.db');
 const h=await createIntegration({databasePath:file});
 try{
  await repository.setCalendarAvailabilityEnabled(h.database,true,now);
  await repository.replaceCalendarAvailabilityDays(h.database,aggregateBusyMinutes([],range(),now.toISOString()));
  const expected=await repository.listCalendarAvailabilityDays(h.database);h.connection.close();
  const reopened=createDatabase(file);
  try{
   await repository.initializeLocalDatabase(reopened.database);
   assert.equal((await repository.loadCalendarAvailabilityState(reopened.database)).enabled,true);
   assert.deepEqual(await repository.listCalendarAvailabilityDays(reopened.database),expected);
  }finally{reopened.connection.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
