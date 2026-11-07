import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createDatabase} from './helpers/sqlite.mjs';
const {initializeLocalDatabase}=await import('../src/platform/storage/repository.ts');
const {initializePersonalGoogleCalendar}=await import('../src/platform/storage/personal-google-calendar.ts');
test('audit100 Calendar import attempt ordering finds the latest counter without rescanning thousands of already applied inbox rows',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'liflow-inbox-index-'));const path=join(dir,'audit.db');const h=createDatabase(path);let closed=false;t.after(()=>{if(!closed)h.connection.close();rmSync(dir,{recursive:true,force:true});});
 await initializeLocalDatabase(h.database);await initializePersonalGoogleCalendar(h.database);h.connection.exec('BEGIN');const insert=h.connection.prepare('INSERT INTO calendar_google_inbox(subject,calendar_id,google_id,event_json,dirty,attempt_order) VALUES(?,?,?,?,0,?)');for(let i=0;i<20000;i++)insert.run('account','calendar',`e${i}`,JSON.stringify({id:`e${i}`,status:'cancelled'}),i);insert.run('other','calendar','foreign','{}',1000000);h.connection.exec('COMMIT');h.connection.close();closed=true;
 const source=readFileSync(new URL('../src/features/calendar/personal-google-sync.ts',import.meta.url),'utf8');const sql=source.match(/'(SELECT coalesce\(max\(attempt_order\),0\) n FROM calendar_google_inbox[^']+)'/u)?.[1];assert.ok(sql);
 const result=JSON.parse(execFileSync('python3',['-c',"import sqlite3,sys,json,time\nc=sqlite3.connect(sys.argv[1]);c.execute(sys.argv[2],('account','calendar')).fetchone();count=[0]\ndef step():count[0]+=100;return 0\nc.set_progress_handler(step,100);start=time.perf_counter();value=c.execute(sys.argv[2],('account','calendar')).fetchone()[0];elapsed=(time.perf_counter()-start)*1000;print(json.dumps({'value':value,'steps':count[0],'elapsedMs':elapsed}));c.close()",path,sql],{encoding:'utf8'}));console.info(JSON.stringify(result));assert.equal(result.value,19999);assert.ok(result.steps<1000,`inbox MAX VM steps ${result.steps}`);
});
