import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/sharing-v2-plan-fixture.mjs';
import {createV2AuthorityIndex} from '../src/features/sharing/v2/history-view.ts';
import {v2AssignmentLineage} from '../src/features/sharing/v2/assignment-lineage.ts';
test('audit100 inherited assignment lookup visits each policy version rather than scanning every policy for each ancestor',async()=>{
 const f=await fixture();const index=createV2AuthorityIndex(f.state().replica.groupId);let reads=0;let current;
 for(let n=1;n<=400;n++){current=new Proxy({...f.defaultConfiguration,ruleVersion:n,...(n>1?{assignmentSourceVersion:n-1}:{})},{get(target,key){if(key==='ruleVersion')reads++;return target[key];}});
 index.accept({schemaVersion:2,groupId:index.view.groupId,operationId:`policy.${n}`,entityId:'floor',entityType:'chorePolicy',operationType:'patch',authorUserId:'owner',authorDeviceId:'device',deviceSequence:n,logicalClock:n,keyVersion:1,context:n>1?{device:n-1}:{},payload:{configuration:current}});}
 reads=0;const at={context:{device:400}};const versions=v2AssignmentLineage(index.view,at,'floor',current);assert.equal(versions.size,400);assert.ok(versions.has(1));assert.ok(reads<5000,`configuration version reads ${reads}`);
});

test('audit100 indexed configuration versions still exclude unseen writes and reject concurrent different configurations',async()=>{
 const f=await fixture();const index=createV2AuthorityIndex('group');const base={schemaVersion:2,groupId:'group',entityId:'floor',entityType:'chorePolicy',operationType:'patch',authorUserId:'owner',deviceSequence:1,logicalClock:1,keyVersion:1,context:{}};
 index.accept({...base,operationId:'one',authorDeviceId:'a',payload:{configuration:{...f.defaultConfiguration,intervalDays:7}}});index.accept({...base,operationId:'two',authorDeviceId:'b',payload:{configuration:{...f.defaultConfiguration,intervalDays:9}}});
 const at={context:{a:1}};assert.equal(index.view.configurationVersion('floor',1,at).value.intervalDays,7);assert.equal(index.view.configurationVersion('floor',2,at),null);assert.throws(()=>index.view.configurationVersion('floor',1,{context:{a:1,b:1}}),/Unresolved/u);
});
