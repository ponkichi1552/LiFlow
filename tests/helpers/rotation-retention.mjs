import {loadSharedFacts,readSharingCheckpoint,applySharingSnapshot} from '../../src/platform/storage/sharing-ledger.ts';
import {compactSharedReplica,buildSharedReplica} from '../../src/features/sharing/replica.ts';
import {sharedDocumentDigest} from '../../src/features/sharing/crypto.ts';
import {planV2HistoryRetention} from '../../src/features/sharing/v2/history-retention-plan.ts';
import {groupId} from './sharing-v2-repository-fixture.mjs';
export async function retainRotation(h,cutoff){
 const state=await h.owner.repository.readState();const plan=planV2HistoryRetention({...state,cutoff,throughSequence:h.head()});
 const id=`rotation-retention-${cutoff}`;
 await h.owner.repository.commit([h.draft(id,'historyRetention',id,{phase:'proposal',checkpoint:plan.body})]);await h.deliver(h.owner,await h.load(h.owner));await h.deliver(h.member,[]);
 const approval={phase:'approve',proposalId:id,checkpointDigest:sharedDocumentDigest(plan.body),receiptDigest:sharedDocumentDigest(h.receipts.get(id))};
 await h.member.repository.commit([h.draft(`${id}-member`,'historyRetention',`${id}-member`,approval)]);await h.deliver(h.owner,await h.load(h.member));
 await h.owner.repository.commit([h.draft(`${id}-owner`,'historyRetention',`${id}-owner`,approval)]);await h.deliver(h.owner,await h.load(h.owner));
 const all=await h.owner.repository.readState(),facts=await loadSharedFacts(h.owner.database,groupId);const witness={proposal:facts.find(f=>f.operation.operationId===id),proposalReceipt:h.receipts.get(id),approvals:facts.filter(f=>[`${id}-member`,`${id}-owner`].includes(f.operation.operationId))};
 const kept=new Set(plan.retained.map(op=>op.operationId));const base={...compactSharedReplica(all.replica),operations:all.replica.operations.filter(op=>kept.has(op.operationId)||op.deviceSequence>(plan.body.frontier[op.authorDeviceId]??0)),retention:witness};
 for(const device of [h.owner,h.member]){const cp=await readSharingCheckpoint(device.database,groupId);await applySharingSnapshot(device.database,groupId,{base,facts:facts.filter(f=>base.operations.some(op=>op.operationId===f.operation.operationId)),snapshotId:id,throughSequence:h.head()},device.repository.project,cp.cursor,h.now().getTime(),device.repository.evidenceForServerReceipts([...h.receipts.values()]));}
 return{plan,witness,base,replica:buildSharedReplica(groupId,[],base)};
}
