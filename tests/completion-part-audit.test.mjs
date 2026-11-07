import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionIntents } from '../src/features/planner/completion-intents.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve=yes;reject=no; }); return { promise,resolve,reject }; };
const tick=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
function setup(options={}) {
  let saved=structuredClone(options.saved??[]), ordinal=0, reads=0;
  const applied=[]; const storedBeforeApply=[];
  const queue=createCompletionIntents({store:{load:options.load??(async()=>structuredClone(saved)),save:async rows=>{
    assert.ok(rows.length<=128,'protected storage stays bounded');saved=structuredClone(rows);
  }},capture:value=>({...value}),makeId:()=>`new-${++ordinal}`,now:()=>new Date('2026-11-07T01:00:00Z'),isCurrent:()=>true,
  apply:async intent=>{storedBeforeApply.push(saved.some(row=>row.id===intent.id));applied.push(intent.id);},refresh:async()=>{reads++;}});
  return {queue,applied,storedBeforeApply,reads:()=>reads,saved:()=>saved};
}
test('the displayed retry recovers a transient completion-store read failure without remounting or another gesture',async()=>{
  let loads=0;const row={id:'old',key:'bath',target:{chore:'bath'},completed:true,createdAt:'2026-11-07T00:00:00Z',status:'queued'};
  const h=setup({load:async()=>{if(++loads===1)throw new Error('Keychain temporarily unavailable');return[row];}});
  await h.queue.activate();assert.equal(h.queue.getSnapshot().restored,false);
  h.queue.retryRead();await tick();await h.queue.settled();
  assert.equal(loads,2);assert.deepEqual(h.applied,['old']);assert.equal(h.queue.getSnapshot().error,null);
});
test('gestures during a full completion restoration drain without losing old requests or exceeding protected storage bounds',async()=>{
  const loading=deferred();const old=Array.from({length:128},(_,i)=>({id:`old-${i}`,key:`chore-${i}`,target:{chore:`chore-${i}`},
    completed:true,createdAt:'2026-11-07T00:00:00Z',status:'queued'}));
  const h=setup({saved:old,load:()=>loading.promise});const activation=h.queue.activate();
  assert.equal(h.queue.request('new-chore',{chore:'new-chore'},true),true);loading.resolve(old);await activation;await tick();await h.queue.settled();
  assert.equal(h.applied.length,129);assert.equal(new Set(h.applied).size,129);assert.ok(h.storedBeforeApply.every(Boolean));
  assert.deepEqual(h.saved(),[]);assert.equal(h.queue.getSnapshot().failed.size,0);assert.equal(h.queue.getSnapshot().pending.size,0);
});
