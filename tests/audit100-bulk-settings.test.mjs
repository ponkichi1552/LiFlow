import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from './helpers/sqlite.mjs';
const repo=await import('../src/platform/storage/repository.ts');
test('audit100 bulk chore enable changes validate and write bounded sets instead of issuing one SQLite read and write per chore',async t=>{
 const h=createDatabase();t.after(()=>h.connection.close());await repo.initializeLocalDatabase(h.database);const snapshot=await repo.loadPlannerSnapshot(h.database);
 const ids=snapshot.chores.filter(chore=>!chore.archived).slice(0,40).map(row=>row.id);assert.equal(ids.length,40);
 let definitionReads=0,definitionWrites=0;for(const name of ['getFirstAsync','getAllAsync','runAsync']){const original=h.database[name];h.database[name]=async(sql,...args)=>{
 if(name!=='runAsync'&&/SELECT id,\s*enabled,\s*definition_json FROM chore_definitions WHERE/u.test(sql))definitionReads++;
 if(name==='runAsync'&&sql.startsWith('UPDATE chore_definitions SET enabled'))definitionWrites++;
 return original(sql,...args);};}
 await repo.setChoresEnabled(h.database,ids,false);const counts={reads:definitionReads,writes:definitionWrites};const after=await repo.loadPlannerSnapshot(h.database);
 assert.ok(after.chores.filter(row=>ids.includes(row.id)).every(row=>!row.enabled));assert.ok(counts.reads<=2,`bulk definition reads: ${counts.reads}`);assert.ok(counts.writes<=2,`bulk definition writes: ${counts.writes}`);
 const before=h.connection.serialize();await assert.rejects(repo.setChoresEnabled(h.database,[ids[0],'not-a-chore'],true));assert.deepEqual(h.connection.serialize(),before);
});
