import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './helpers/sqlite.mjs';
import { applianceResult } from './helpers/sharing-v2-appliance.mjs';
const { sharedDocumentDigest } = await import('../src/features/sharing/crypto.ts');
const { v2RetainedCompletions } = await import('../src/features/sharing/v2/retained-completions.ts');
const { commonFrames } = await import('../src/features/sharing/v2/common-frames.ts');
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { retainSharedApplianceCopies } = await import('../src/platform/storage/appliance-manuals.ts');

test('audit100 retained completions index targeted undos instead of scanning every undo for each retained round', () => {
  const body = { timeZone: 'UTC', roundStates: Array.from({ length: 500 }, (_, n) => ({ choreId: `chore-${n}`, anchorDate: '2026-10-01', subjectUserId: null, instant: 1000, reports: [{ recorderUserId: 'owner', instant: 1000 }] })) };
  const digest = sharedDocumentDigest(body); let reads = 0;
  const undos = Array.from({ length: 100 }, (_, n) => ({ authorDeviceId: 'device', deviceSequence: 1, payload: { checkpointId: digest, get choreId() { reads++; return `chore-${n}`; }, anchorDate: '2026-10-01', subjectUserId: null, recorderUserIds: ['owner'] } }));
  const view = { retentionAt: () => body, ofType: () => undos };
  const result = v2RetainedCompletions(view, { context: { device: 1 } });
  assert.equal(result.filter(row => !row.reports.length).length, 100); assert.equal(result.length, 500);
  assert.ok(reads <= 200, `undo matching reads: ${reads}`);
});
test('audit100 common frame expansion validates invariant recurrence input once per range rather than every round', () => {
  let reads = 0; const cfg = { get anchorDate() { reads++; return '2026-01-01'; }, intervalDays: 1, ruleVersion: 1, windowBeforeDays: 2, windowAfterDays: 2 };
  const rows = commonFrames('group', 'chore', cfg, '2026-01-01', '2026-12-31');
  assert.equal(rows.length, 365); assert.equal(rows[364].anchorDate, '2026-12-31'); assert.equal(rows[364].windowEnd, '2027-01-02');
  assert.ok(reads <= 5, `invariant anchor reads: ${reads}`);
  assert.throws(() => commonFrames('group', 'chore', { ...cfg, intervalDays: 0 }, '2026-01-01', '2026-01-02'));
});
test('audit100 unchanged retained appliance libraries do not fetch a receipt separately for every product', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const result = applianceResult(); const copies = Array.from({ length: 100 }, (_, n) => ({ manual: null, appliance: { ...result.product, modelNumber: `MODEL-${n}`, id: `shared-${n}`, householdId: 'shared:group', displayName: `家電-${n}`, officialManualUrl: result.officialSources.manualUrl, analysis: result.analysis, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' } }));
  assert.equal(await retainSharedApplianceCopies(h.database, 'group', copies, () => {}), true);
  let reads = 0; const original = h.database.getFirstAsync; h.database.getFirstAsync = async (...args) => { reads++; return original(...args); };
  assert.equal(await retainSharedApplianceCopies(h.database, 'group', copies, () => {}), false);
  assert.ok(reads <= 3, `one hundred unchanged products made ${reads} individual reads`);
  assert.equal(h.connection.prepare('SELECT count(*) n FROM appliances').get().n, 100);
});

test('audit100 current retained round lookups reuse a projection index without scanning every retained completion per occurrence', async () => {
  const { indexRetainedRounds }=await import('../src/features/sharing/v2/retained-round-index.ts');let reads=0;
  const rows=Array.from({length:1000},(_,n)=>({get choreId(){reads++;return `chore-${n%10}`;},anchorDate:`2026-01-${String(n%28+1).padStart(2,'0')}`,ruleVersion:1,reports:n%2?[]:[{recorderUserId:'owner'}]}));
  const index=indexRetainedRounds(rows);
  for(let n=0;n<100;n++)assert.deepEqual(index.forRound(`chore-${n%10}`,`2026-01-${String(n%28+1).padStart(2,'0')}`,1),rows.filter((row,i)=>i%10===n%10&&i%28===n%28));
  assert.equal(index.forChore('chore-0').length,100);assert.ok(reads<5000,`retained chore reads: ${reads}`);
});

test('audit100 Google completion revision metadata does not change with the devices collation locale',async()=>{
 const {fixture}=await import('./helpers/sharing-v2-plan-fixture.mjs');const {v2GoogleTaskItems}=await import('../src/features/sharing/v2/google-tasks-projection.ts');const f=await fixture();f.complete();const plan=f.plan();assert.ok(plan.history[0]);plan.history=[{...plan.history[0],operationId:'Case.a'},{...plan.history[0],operationId:'Case.A'}];
 const original=String.prototype.localeCompare;const english=new Intl.Collator('en').compare,danish=new Intl.Collator('da').compare;try{
 String.prototype.localeCompare=function(other){return english(String(this),String(other));};const first=v2GoogleTaskItems(plan,'a').map(row=>row.localRevision);String.prototype.localeCompare=function(other){return danish(String(this),String(other));};assert.deepEqual(v2GoogleTaskItems(plan,'a').map(row=>row.localRevision),first);
 }finally{String.prototype.localeCompare=original;}
});
