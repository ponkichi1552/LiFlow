import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {previousCompletionState}=await import('../src/platform/storage/completion-journal.ts');
test('audit100 undoing a long invalidated completion lineage uses indexed parents instead of rescanning the journal at each step',()=>{
 let reads=0;const history=Array.from({length:500},(_,i)=>new Proxy({sequence:500-i,completion_id:`c${500-i}`,action:'complete',previous_action_sequence:500-i===1?null:499-i,previous_chore_state_json:JSON.stringify({choreId:'c',lastCompletedDate:'2026-01-01',lastCompletedEstimated:true}),outcome:'incomplete',cycleDate:'2026-01-01'},{get(t,k){if(k==='sequence')reads++;return t[k];}}));
 const heads=new Map(history.map(row=>[row.completion_id,row]));const result=previousCompletionState(history[0],history,heads,history);
 assert.equal(result.lastCompletedDate,'2026-01-01');assert.ok(reads<5000,`journal sequence reads ${reads}`);
 const active={...history[250],outcome:'completed'};const nextHeads=new Map(heads);nextHeads.set(active.completion_id,active);assert.deepEqual(previousCompletionState(history[0],history,nextHeads,history),JSON.parse(history[249].previous_chore_state_json));
});
