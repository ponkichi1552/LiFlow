import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeSharingLedger,createLocalSharedOperations,listSharingOutbox,deferSharingUpload }=await import('../src/platform/storage/sharing-ledger.ts');
test('audit100 a deferred first shared Outbox record does not parse the blocked hundred-operation suffix',async t=>{
  const h=createDatabase();t.after(()=>h.connection.close());await initializeSharingLedger(h.database);
  await createLocalSharedOperations(h.database,{groupId:'group',userId:'user',deviceId:'device',keyVersion:1},Array.from({length:100},(_,n)=>({operationId:`op-${n}`,entityType:'chore',entityId:'floor',operationType:'patch',payload:{name:`床掃除${n}`}})),async()=>{});
  await deferSharingUpload(h.database,'op-0',1000,.5);
  let parsed=0;const read=h.database.getAllAsync;
  h.database.getAllAsync=async(sql,...args)=>(await read(sql,...args)).map(row=>{if(!sql.includes('FROM sharing_outbox q'))return row;return{...row,get operation_json(){parsed++;return row.operation_json;}};});
  assert.deepEqual(await listSharingOutbox(h.database,'group',1000),[]);
  assert.equal(parsed,0,'undue causal suffix does not require JSON or payload validation');
  const due=await listSharingOutbox(h.database,'group',10000);assert.equal(due.length,100);assert.equal(due[0].operation.operationId,'op-0');
});
