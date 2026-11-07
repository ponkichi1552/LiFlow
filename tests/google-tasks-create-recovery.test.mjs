import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { memoryTaskClaims } from './helpers/shared-task-claims.mjs';
import { sharedTaskCreateJournal } from '../src/features/google-sync/shared-task-create-journal.ts';
import { createGoogleOperationBudget } from '../src/features/google-sync/operation-budget.ts';
import { sharedGoogleOccurrenceNote } from '../src/features/google-sync/workspace-policy.ts';
import { googleTaskBatchFailure } from '../src/features/google-sync/batch-failure.ts';

test('inventory adoption cannot borrow a newer reservation or poison its local success receipt',async()=>{
  const h=await googleFixture(),remote=memoryTaskClaims(h.namespace),budget=createGoogleOperationBudget(60_000);
  const journal=sharedTaskCreateJournal(h.store.port.taskCreateJournal,remote.cloud,{budget,assertCurrent:async()=>{}});
  try{
    const identity={accountSubject:'audit-account',taskListId:'audit-list',occurrenceMarker:sharedGoogleOccurrenceNote(h.namespace,'old-round')};
    const intent=await journal.reserve(identity);assert.ok(intent);
    await assert.rejects(journal.linked(identity,'old-task-id'),{code:'task_create_result_pending'});
    const local=await h.store.port.taskCreateJournal.read(identity);assert.equal(local.intent.attemptId,intent.attemptId);assert.equal(local.taskId,null);
    assert.equal((await remote.cloud.read(identity)).phase,'reserved');
  }finally{budget.close();h.close();}
});

for(const count of [10,50,100])test(`definitive rejection cleanup batches ${count} reservations without releasing unknown successes`,async()=>{
  const h=await googleFixture();const remote=memoryTaskClaims(h.namespace);const budget=createGoogleOperationBudget(60_000);let cloudBatches=0,localBatches=0,guards=0;
  const local={...h.store.port.taskCreateJournal,rejectBatch:async rows=>{localBatches++;return h.store.port.taskCreateJournal.rejectBatch(rows);}};
  const cloud={...remote.cloud,rejectBatch:async rows=>{cloudBatches++;return remote.cloud.rejectBatch(rows);}};
  const journal=sharedTaskCreateJournal(local,cloud,{budget,assertCurrent:async()=>{guards++;}});
  try{
    const identities=Array.from({length:count},(_,n)=>({accountSubject:'audit-account',taskListId:'audit-list',occurrenceMarker:sharedGoogleOccurrenceNote(h.namespace,`audit-marker-${n}`)}));
    const intents=await journal.reserveBatch(identities);assert.ok(intents.every(Boolean));
    const start=performance.now();await journal.rejectBatch(intents);
    assert.equal(cloudBatches,1);assert.equal(localBatches,1);assert.equal(h.d.connection.prepare('SELECT count(*) n FROM private_google_task_create_intents WHERE remote_task_id IS NULL').get().n,0);
    console.log(JSON.stringify({audit:'N03-O01',count,cloudRejectBatchCalls:cloudBatches,localRejectBatchCalls:localBatches,guardCalls:guards,elapsedMs:performance.now()-start}));
  }finally{budget.close();h.close();}
});

for (const failure of ['link-save', 'cloud-linked', 'cloud-rejected']) test(`received create outcomes survive ${failure} and retry only definitive rejections`, async () => {
  const h = await googleFixture(); const remote = memoryTaskClaims(h.namespace); const budget = createGoogleOperationBudget(60_000);
  let fail = true; let mixed = true;
  const cloud = { ...remote.cloud,
    linked: async (...args) => { if (failure === 'cloud-linked' && fail) { fail = false; throw Object.assign(new Error('offline'), { code: 'unavailable' }); } return remote.cloud.linked(...args); },
    rejectBatch: async (...args) => { if (failure === 'cloud-rejected' && fail) { fail = false; throw Object.assign(new Error('offline'), { code: 'unavailable' }); } return remote.cloud.rejectBatch(...args); } };
  const journal = sharedTaskCreateJournal(h.store.port.taskCreateJournal, cloud, { budget, assertCurrent: async () => {} });
  const port = { ...h.store.port, taskCreateJournal: journal,
    upsertGoogleTaskLink: async link => { if (failure === 'link-save' && fail) { fail = false; throw new Error('disk write'); } return h.store.port.upsertGoogleTaskLink(link); } };
  h.api.createTasksBatch = async (token, list, drafts) => {
    const results = [];
    for (const [index, draft] of drafts.entries()) results.push(mixed && index === 1 ? { ok: false, status: 429, code: 'quota' }
      : { ok: true, task: await h.api.createTask(token, list, draft) });
    mixed = false; return results;
  };
  try {
    await h.connect(); await assert.rejects(h.sync(port));
    assert.ok(h.d.connection.prepare('SELECT count(*) n FROM private_google_task_create_results').get().n > 0);
    await h.sync(port); await h.sync(port);
    assert.equal(h.tasks.size, 3); assert.equal(h.calls.filter(call => call[0] === 'create').length, 3);
    assert.equal((await h.links()).length, 3);
    assert.equal(h.d.connection.prepare('SELECT count(*) n FROM private_google_task_create_results').get().n, 0);
    assert.ok([...remote.rows.values()].every(row => row.phase === 'linked'));
  } finally { budget.close(); h.close(); }
});

test('batch retry deadlines cover every unresolved item independently of request and response order', () => {
  const received = Date.parse('2026-11-07T03:00:00Z');
  const failures = [{ ok: false, status: 429, code: 'quota', retryAfter: '3600' },
    { ok: false, status: 429, code: 'quota', retryAfter: '14400' },
    { ok: false, status: 503, code: 'unavailable', retryAfter: 'Sat, 07 Nov 2026 08:00:00 GMT' }];
  const first = googleTaskBatchFailure(failures, received); const last = googleTaskBatchFailure([...failures].reverse(), received);
  assert.equal(first.status, 429); assert.equal(first.retryAfter, '2026-11-07T08:00:00.000Z');
  assert.equal(last.status, first.status); assert.equal(last.code, first.code); assert.equal(last.retryAfter, first.retryAfter);
});

test('out-of-range batch Retry-After cannot mask provider failures or discard a valid sibling backoff', () => {
  const received = Date.parse('2026-11-07T03:00:00Z');
  const failure = googleTaskBatchFailure([{ ok: false, status: 429, code: 'quota', retryAfter: '1e14' },
    { ok: false, status: 503, code: 'unavailable', retryAfter: '3600' }], received);
  assert.equal(failure.status, 429); assert.equal(failure.retryAfter, '2026-11-07T04:00:00.000Z');
});

test('audit100 recovered Tasks insert outcomes settle one chunk without a separate acknowledgement transaction for every result', async () => {
  const h=await googleFixture();let settlements=0;const local=h.store.port.taskCreateJournal;
  const journal={...local,settled:async rows=>{if(rows.length)settlements++;return local.settled(rows);}};
  try{await h.connect();await h.sync({...h.store.port,taskCreateJournal:journal});assert.equal(h.tasks.size,3);assert.equal(settlements,1);
    assert.deepEqual(await local.pending({accountSubject:'synthetic-google-subject',taskListId:'v2-private-list'}),[]);
  }finally{h.close();}
});
