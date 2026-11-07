import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from './helpers/sqlite.mjs';
const repo=await import('../src/platform/storage/repository.ts');
test('audit100 regenerating a personal schedule stores and removes changed cache rows in bounded statements without rewriting unchanged plans',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-07T03:00:00Z')});const h=createDatabase();t.after(()=>h.connection.close());await repo.initializeLocalDatabase(h.database);
 const initial=await repo.loadPlannerSnapshot(h.database);const ids=initial.chores.filter(row=>!row.archived&&row.personalSchedulingKind!=='seasonal').slice(0,30).map(row=>row.id);assert.equal(ids.length,30);
 await repo.completeFirstSetup(h.database,{frequencyMode:'balanced',restDays:[1,2,3,4,5,6,7],enabledChoreIds:[],previousDates:{},weatherLocation:null});
 const run=h.database.runAsync;let writes=0;h.database.runAsync=async(sql,...args)=>{if(/^(?:INSERT INTO chore_schedule_entries|DELETE FROM chore_schedule_entries)/u.test(sql.trim()))writes++;return run(sql,...args);};
 await repo.setChoresEnabled(h.database,ids,true);await repo.loadPlannerSnapshot(h.database);const rows=h.connection.prepare('SELECT * FROM chore_schedule_entries').all();assert.ok(rows.length>=20);assert.ok(writes<=4,`cache change writes ${writes}`);
 writes=0;await repo.loadPlannerSnapshot(h.database);assert.equal(writes,0);assert.deepEqual(h.connection.prepare('SELECT * FROM chore_schedule_entries').all(),rows);
});
