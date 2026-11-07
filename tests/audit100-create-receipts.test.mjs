import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
const { createGoogleTaskCreateJournal, initializeGoogleTaskCreateIntentsInside } = await import('../src/platform/storage/google-task-create-intents.ts');

test('audit100 recording a hundred Tasks creation outcomes validates and writes one bounded SQLite batch', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeGoogleTaskCreateIntentsInside(h.database);
  let sequence = 0; const journal = createGoogleTaskCreateJournal(async work => { let value; await h.database.withTransactionAsync(async () => { value = await work(h.database); }); return value; }, () => `attempt-${++sequence}`, () => new Date('2026-11-07T03:00:00Z'));
  const intents = []; for (let n = 0; n < 100; n++) intents.push(await journal.reserve({ accountSubject: 'account', taskListId: 'list', occurrenceMarker: `round-${n}` }));
  const results = intents.map((intent, n) => n % 2 ? { intent, kind: 'rejected' } : { intent, kind: 'created', taskId: `task-${n}` });
  let calls = 0; for (const name of ['getFirstAsync', 'getAllAsync', 'runAsync']) { const original = h.database[name]; h.database[name] = async (...args) => { calls++; return original(...args); }; }
  await journal.received(results);
  assert.ok(calls <= 3, `SQLite receipt bridge calls: ${calls}`);
  assert.deepEqual(await journal.pending({ accountSubject: 'account', taskListId: 'list' }), results);
  await journal.received(results);
  await assert.rejects(journal.received([{ ...results[0], taskId: 'conflicting-result' }]));
  assert.equal((await journal.pending({ accountSubject: 'account', taskListId: 'list' }))[0].taskId, 'task-0');
});

test('audit100 acknowledged Tasks creation receipts are cleaned in one bounded compare-and-delete batch', async t => {
  const h=createDatabase();t.after(()=>h.connection.close());await initializeGoogleTaskCreateIntentsInside(h.database);let n=0;
  const journal=createGoogleTaskCreateJournal(async work=>{let value;await h.database.withTransactionAsync(async()=>{value=await work(h.database);});return value;},()=>`ack-${++n}`,()=>new Date('2026-11-07T03:00:00Z'));
  const results=[];for(let i=0;i<100;i++){const intent=await journal.reserve({accountSubject:'owner',taskListId:'list',occurrenceMarker:`round-${i}`});results.push({intent,kind:'created',taskId:`task-${i}`});}
  await journal.received(results);let deletes=0;const run=h.database.runAsync;h.database.runAsync=async(sql,...args)=>{if(sql.startsWith('DELETE FROM private_google_task_create_results'))deletes++;return run(sql,...args);};
  await journal.settled(results.map((r,i)=>i? r : {...r,taskId:'wrong'}));
  assert.equal((await journal.pending({accountSubject:'owner',taskListId:'list'})).length,1);
  assert.equal(deletes,1);await journal.settled([results[0]]);assert.deepEqual(await journal.pending({accountSubject:'owner',taskListId:'list'}),[]);
});
