import {fixture,seeds,groupId,draft} from './sharing-v2-repository-fixture.mjs';
import {createV2PlannerActions} from '../../src/features/sharing/v2/actions.ts';
import {chorePolicyFromPreset} from '../../src/features/sharing/v2/model.ts';
import {loadSharedFacts,applyReceivedSharedFacts,readSharingCheckpoint} from '../../src/platform/storage/sharing-ledger.ts';
import {v2AuthorProofDigest} from '../../src/features/sharing/v2/server-receipts.ts';

export async function rotationFixture(t,{basis='completion',sequence=['owner','member'],anchor='2026-10-27',schedulerVersion}={}){
 let clock=new Date(`${anchor}T01:00:00Z`);let n=0;const f=await fixture({clock:()=>clock,schedulerVersion});
 const owner=await f.device();const member=await f.device('member',f.member);t.after(()=>{owner.connection.close();member.connection.close();});
 const actions=device=>createV2PlannerActions(device.repository,{now:()=>clock,makeId:()=>`${device.options.userId}-rotation-${++n}`});
 const a=actions(owner),b=actions(member);const initial=seeds();initial[1].payload.anchorDate=anchor;initial[3].payload.configuration.anchorDate=anchor;
 await owner.repository.commit(initial);
 if(schedulerVersion?.endsWith('53'))return{f,owner,member,a,b,anchor};
 await a.patchChoreConfiguration('floor',1,{policy:chorePolicyFromPreset('rotation',sequence,basis)},anchor);
 const receipts=new Map(),facts=new Map();let head=0;
 async function deliver(device,input=[]){
  for(const fact of [...input].sort((a,b)=>a.operation.logicalClock-b.operation.logicalClock||(a.operation.operationId<b.operation.operationId?-1:1)))if(!facts.has(fact.operation.operationId)){
   const op=fact.operation;facts.set(op.operationId,fact);receipts.set(op.operationId,{schemaVersion:2,groupId,operationId:op.operationId,authorUserId:op.authorUserId,authorDeviceId:op.authorDeviceId,receivedKeyVersion:op.keyVersion,uploadSequence:++head,authorProofDigest:v2AuthorProofDigest(fact),receivedAtMs:clock.getTime()});
  }
  const checkpoint=await readSharingCheckpoint(device.database,groupId);
  await applyReceivedSharedFacts(device.database,groupId,[...facts.values()],String(head),device.repository.project,checkpoint.cursor,clock.getTime(),device.repository.evidenceForServerReceipts([...receipts.values()]));
 }
 const plan=()=>a.readPlan({from:anchor,through:'2026-12-31',asOfDate:clock.toISOString().slice(0,10)});
 return{f,owner,member,a,b,receipts,deliver,head:()=>head,now:()=>clock,setDay:day=>{clock=new Date(`${day}T01:00:00Z`);},plan,
  ref:(day,version=2)=>({choreId:'floor',anchorDate:day,ruleVersion:version,subjectUserId:null}),load:device=>loadSharedFacts(device.database,groupId),draft};
}
