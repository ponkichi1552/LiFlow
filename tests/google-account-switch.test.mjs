import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createDatabase } from './helpers/sqlite.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import * as binding from '../src/features/google-sync/account-binding.ts';
import * as budget from '../src/features/google-sync/operation-budget.ts';
import * as lock from '../src/features/google-sync/operation-lock.ts';
import * as accountEvents from '../src/features/google-sync/account-change-events.ts';
const repository = await import('../src/platform/storage/repository.ts');
const archive = await import('../src/platform/storage/google-account-archive.ts');
const calendars = await import('../src/platform/storage/personal-google-calendar.ts');
const householdId = repository.LOCAL_HOUSEHOLD_ID;
const now = '2026-11-05T00:00:00.000Z';
const state = subject => ({ householdId, accountSubject: subject, enabled: true, taskListId: `list-${subject}`, status: 'idle', retryCount: 0, updatedAt: now });
const link = (subject, n = 0) => ({ householdId, scheduleEntryId: `entry-${n}`, choreId: 'synthetic', googleTaskId: `task-${subject}-${n}`, googleTaskListId: `list-${subject}`, createdAt: now, updatedAt: now });
const rows = (h, name) => h.connection.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
const business = h => createHash('sha256').update(JSON.stringify(['household_settings', 'chore_definitions', 'chore_completions', 'chore_schedule_entries'].map(name => rows(h, name)))).digest('hex');
async function fixture() {
  const h = createDatabase(); await repository.initializeLocalDatabase(h.database);
  await repository.saveGoogleSyncState(h.database, state('a')); await repository.upsertGoogleTaskLink(h.database, link('a'));
  await repository.saveCalendarAvailabilityState(h.database, { householdId, enabled: true, status: 'idle', retryCount: 0, updatedAt: now });
  await repository.replaceCalendarAvailabilityDays(h.database, [{ localDate: '2026-11-05', busyMinutes: 300, timeZone: 'Asia/Tokyo', fetchedAt: now }]);
  return h;
}
function controller(h, subject = 'b', nativeRead) {
  let native = subject; let firebase = 'firebase-b'; const events = [];
  const module = loadNativeModule('src/features/google-sync/account-switch.ts', {
    '../../platform/storage/google-account-archive': archive,
    '../../platform/google-tasks/google-sign-in-gateway': { getCurrentGoogleSubject: nativeRead ?? (async () => native), GoogleSignInRequiredError: class extends Error {} },
    './account-binding': binding, './operation-lock': lock, './operation-budget': budget,
    './account-change-events': accountEvents,
    '../../platform/sharing/auth': { switchSharingGoogleAccount: async () => { events.push('choose'); return { uid: 'firebase-b', providerData: [{ providerId: 'google.com', uid: subject }] }; } },
    '../../platform/sharing/workspaces': { sharingSessionUser: async () => ({ uid: firebase }) },
  });
  return { module, events, native: value => { native = value; }, firebase: value => { firebase = value; } };
}

test('explicit Google account changes keep independent mappings busy days and pending intents and restore them without business-data changes', async () => {
  const h = await fixture();
  try {
    for (let n = 1; n <= 215; n++) await repository.upsertGoogleTaskLink(h.database, link('a', n));
    h.connection.exec("UPDATE google_task_links SET pending_status='completed',pending_status_revision='queued-old-a' WHERE schedule_entry_id='entry-0'");
    h.connection.prepare('INSERT INTO private_google_task_create_intents VALUES(?,?,?,?,?,?)').run('a','list-a','round-a','attempt-a',now,null);
    const original = ['google_sync_state','google_task_links','calendar_availability_state','calendar_availability_days'].map(name => rows(h,name)); const originalBusiness = business(h);
    await controller(h).module.changeGoogleAccount(h.database);
    const fresh = await repository.loadGoogleSyncState(h.database);
    assert.equal(fresh.accountSubject, 'b'); assert.equal(fresh.enabled, false); assert.equal(fresh.disconnected, true); assert.equal(fresh.taskListId, undefined);
    assert.deepEqual(await repository.listGoogleTaskLinks(h.database), []); assert.deepEqual(await repository.listCalendarAvailabilityDays(h.database), []);
    assert.equal(await repository.loadCalendarAvailabilityState(h.database), null); assert.equal(business(h), originalBusiness);
    await repository.saveGoogleSyncState(h.database, state('b')); await repository.upsertGoogleTaskLink(h.database, link('b'));
    const bState = rows(h,'google_sync_state'), bLinks = rows(h,'google_task_links');
    await archive.activatePersonalGoogleTaskAccount(h.database,'a',async () => {});
    for (const [n,name] of ['google_sync_state','google_task_links','calendar_availability_state','calendar_availability_days'].entries()) assert.deepEqual(rows(h,name),original[n]);
    assert.equal(business(h),originalBusiness); assert.equal(h.connection.prepare('SELECT count(*) n FROM private_google_task_create_intents WHERE account_subject=? AND remote_task_id IS NULL').get('a').n,1);
    await archive.activatePersonalGoogleTaskAccount(h.database,'b',async () => {});
    assert.deepEqual(rows(h,'google_sync_state'),bState); assert.deepEqual(rows(h,'google_task_links'),bLinks);
    await assert.rejects(repository.bindGoogleSyncAccount(h.database,'a'),binding.GoogleAccountMismatchError,'ordinary/background binding still cannot silently replace an account');
  } finally { h.connection.close(); }
});

test('account changes rollback every saved row if identity changes before commit and reject mismatched Google or Firebase identity', async () => {
  const h = await fixture();
  try {
    const before = ['google_sync_state','google_task_links','calendar_availability_state','calendar_availability_days'].map(name=>rows(h,name)); let guards = 0;
    await assert.rejects(archive.activatePersonalGoogleTaskAccount(h.database,'b',async()=>{if(++guards===2)throw new Error('changed before commit');}),/changed before commit/);
    for(const [i,name] of ['google_sync_state','google_task_links','calendar_availability_state','calendar_availability_days'].entries())assert.deepEqual(rows(h,name),before[i]);
    const google = controller(h); google.native('substituted'); await assert.rejects(google.module.changeGoogleAccount(h.database),binding.GoogleAccountMismatchError);
    const firebase = controller(h); firebase.firebase('substituted'); await assert.rejects(firebase.module.changeGoogleAccount(h.database),binding.GoogleAccountMismatchError);
    assert.deepEqual(rows(h,'google_sync_state'),before[0]); assert.deepEqual(rows(h,'google_task_links'),before[1]);
  } finally { h.connection.close(); }
});

test('selecting the active Google account makes no archive or state change and unbound legacy mappings are never assigned to a new account', async () => {
  const h = await fixture();
  try {
    const before = rows(h,'google_sync_state');
    assert.equal(await archive.activatePersonalGoogleTaskAccount(h.database,'a',async()=>{}),false);
    assert.deepEqual(rows(h,'google_sync_state'),before); assert.equal(h.connection.prepare("SELECT count(*) n FROM sqlite_master WHERE name='personal_google_account_archives'").get().n,0);
    h.connection.exec('UPDATE google_sync_state SET account_subject=NULL');
    await archive.activatePersonalGoogleTaskAccount(h.database,'b',async()=>{});
    assert.deepEqual(await repository.listGoogleTaskLinks(h.database),[]);
    const saved=h.connection.prepare('SELECT value_json FROM personal_google_account_archive_rows WHERE account_key=? AND table_name=?').get('["unbound"]','google_task_links');
    assert.equal(JSON.parse(saved.value_json).google_task_id,'task-a-0');
  } finally { h.connection.close(); }
});

test('account activation waits for the previous Google operation and archives its final write', async () => {
  const h = await fixture(); let release;
  try {
    const gate=new Promise(resolve=>{release=resolve;});
    const old=lock.withGoogleSyncOperation(async()=>{await gate;await repository.upsertGoogleTaskLink(h.database,link('a',77));});
    const next=controller(h).module.activateCurrentGoogleTaskAccount(h.database);
    await new Promise(setImmediate);assert.equal((await repository.loadGoogleSyncState(h.database)).accountSubject,'a');release();await old;await next;
    await archive.activatePersonalGoogleTaskAccount(h.database,'a',async()=>{});
    assert.equal((await repository.listGoogleTaskLinks(h.database)).some(row=>row.googleTaskId==='task-a-77'),true);
  } finally { release?.();h.connection.close(); }
});

test('an unreadable archived account rolls back the active connection instead of deleting its mappings', async () => {
  const h = await fixture();
  try {
    await archive.activatePersonalGoogleTaskAccount(h.database,'b',async()=>{});
    await repository.saveGoogleSyncState(h.database,state('b'));await repository.upsertGoogleTaskLink(h.database,link('b'));
    const before = rows(h,'google_sync_state'), links = rows(h,'google_task_links');
    h.connection.prepare('UPDATE personal_google_account_archive_rows SET value_json=? WHERE account_key=? AND table_name=?').run('{"household_id":"other-household"}','["google","a"]','google_task_links');
    await assert.rejects(archive.activatePersonalGoogleTaskAccount(h.database,'a',async()=>{}),/一致/);
    assert.deepEqual(rows(h,'google_sync_state'),before);assert.deepEqual(rows(h,'google_task_links'),links);
    assert.equal(h.connection.prepare('SELECT count(*) n FROM personal_google_account_archive_rows WHERE account_key=?').get('["google","a"]').n>0,true);
  } finally { h.connection.close(); }
});

test('Calendar account controls follow an explicit account change atomically and returning accounts keep pending cursors with a fresh generation', async () => {
  const h=await fixture();
  try {
    await calendars.initializePersonalGoogleCalendar(h.database);
    const a=await calendars.connectPersonalGoogleCalendar(h.database,0,'a',[{id:'calendar-a',summary:'A',accessRole:'owner',primary:true}],'calendar-a');
    h.connection.prepare('INSERT INTO calendar_google_cursors(subject,calendar_id,sync_token,page_token,scan_id) VALUES(?,?,?,?,?)').run('a','calendar-a','saved-sync-token',null,null);
    const cursors=rows(h,'calendar_google_cursors');
    await archive.activatePersonalGoogleTaskAccount(h.database,'b',async()=>{});
    const b=await calendars.readPersonalGoogleCalendarControl(h.database);assert.equal(b.subject,'b');assert.equal(b.enabled,false);assert.ok(b.generation>a.generation);
    assert.deepEqual(rows(h,'calendar_google_cursors'),cursors);
    await archive.activatePersonalGoogleTaskAccount(h.database,'a',async()=>{});
    const restored=await calendars.readPersonalGoogleCalendarControl(h.database);assert.deepEqual({...restored,generation:a.generation},a);assert.ok(restored.generation>b.generation);
    await assert.rejects(calendars.withPersonalGoogleCalendar(h.database,a,async()=>assert.fail('old response must not commit')),/接続先/);
    assert.deepEqual(rows(h,'calendar_google_cursors'),cursors);
    // A deliberately changed Calendar connection also retains its previous control.
    await calendars.connectPersonalGoogleCalendar(h.database,restored.generation,'c',[{id:'calendar-c',summary:'C',accessRole:'owner',primary:true}],'calendar-c');
    await archive.activatePersonalGoogleTaskAccount(h.database,'a',async()=>{});
    const final=await calendars.readPersonalGoogleCalendarControl(h.database);assert.equal(final.subject,'a');assert.equal(final.enabled,true);assert.equal(final.targetCalendarId,'calendar-a');
  }finally{h.connection.close();}
});

test('a stalled native identity at the account commit fence rolls back and late identity cannot change the active connection', async t => {
  const h = await fixture();let release;let reads=0;
  try {
    const before=rows(h,'google_sync_state'), links=rows(h,'google_task_links');
    const c=controller(h,'b',async()=>{if(++reads===3)return new Promise(resolve=>{release=resolve;});return 'b';});
    t.mock.timers.enable({apis:['setTimeout']});
    const pending=c.module.changeGoogleAccount(h.database);const rejected=assert.rejects(pending,error=>error.name==='AbortError');
    for(let i=0;i<100&&!release;i++)await new Promise(setImmediate);assert.equal(typeof release,'function');
    t.mock.timers.tick(15001);await rejected;
    assert.deepEqual(rows(h,'google_sync_state'),before);assert.deepEqual(rows(h,'google_task_links'),links);
    release('b');await new Promise(setImmediate);assert.deepEqual(rows(h,'google_sync_state'),before);
    t.mock.timers.reset();await controller(h).module.changeGoogleAccount(h.database);assert.equal((await repository.loadGoogleSyncState(h.database)).accountSubject,'b');
  } finally { release?.('b');t.mock.timers.reset();h.connection.close(); }
});

for(const platform of ['ios','android'])test(`${platform} Google Tasks connect can use a different account without reusing the old list or task IDs`,async()=>{
  const h=await fixture();
  try{
    const snapshot=await repository.loadPlannerSnapshot(h.database,'2026-11-05');const c=controller(h);let synced=0;
    const screen=screenHarness('src/app/settings.tsx',{platform,database:h.database,snapshot:()=>snapshot,refresh:async()=>{},mocks:{
      '@/features/google-sync/account-switch':c.module,
      '@/features/google-sync/background-task':{registerGoogleSyncBackgroundTask:async()=>{}},
      '@/features/google-sync/google-oauth-config':{getGoogleSyncOAuthConfig:()=>({configured:true})},
      '@/platform/google-tasks/google-sign-in-gateway':{authorizeGoogleTasks:async()=>{},hasGoogleTasksSession:async()=>false},
      '@/features/google-sync/coordinator':{syncGoogleTasks:async()=>{
        synced++;const current=await repository.loadGoogleSyncState(h.database);assert.equal(current.accountSubject,'b');assert.equal(current.taskListId,undefined);assert.deepEqual(await repository.listGoogleTaskLinks(h.database),[]);
        return{kind:'success',created:0,updated:0,imported:0};
      }},
    }});
    await screen.press('Google連携を開く');await screen.press('Googleと接続');
    assert.equal(synced,1);assert.match(screen.text(),/接続し、同期しました/);assert.equal((await repository.loadGoogleSyncState(h.database)).accountSubject,'b');
    await archive.activatePersonalGoogleTaskAccount(h.database,'a',async()=>{});assert.equal((await repository.listGoogleTaskLinks(h.database))[0].googleTaskId,'task-a-0');
  }finally{h.connection.close();}
});

for(const platform of ['ios','android'])test(`${platform} account changes refresh an already-mounted settings view and discard its older native connection read`,async()=>{
  const h=await fixture();let release;
  try {
    const snapshot=await repository.loadPlannerSnapshot(h.database,'2026-11-05');let reads=0;
    const screen=screenHarness('src/app/settings.tsx',{platform,database:h.database,snapshot:()=>snapshot,refresh:async()=>{},
      effectDependencies:true,effect:callback=>callback(),layoutEffect:callback=>callback(),mocks:{
        '@/features/google-sync/background-task':{},
        '@/features/google-sync/google-oauth-config':{getGoogleSyncOAuthConfig:()=>({configured:true})},
        '@/platform/google-tasks/google-sign-in-gateway':{hasGoogleTasksSession:async expected=>{
          if(++reads===1)return new Promise(resolve=>{release=resolve;});return expected==='a';
        }},
      }});
    for(let i=0;i<30&&!release;i++)await new Promise(setImmediate);assert.equal(typeof release,'function');
    await controller(h).module.changeGoogleAccount(h.database);await screen.flush();
    assert.equal(screen.button('Google連携を開く').props.accessibilityValue.text,'未接続');
    release(true);await screen.flush();assert.equal(screen.button('Google連携を開く').props.accessibilityValue.text,'未接続');
    screen.unmount();
  }finally{release?.(true);h.connection.close();}
});
