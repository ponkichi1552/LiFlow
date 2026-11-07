import './helpers/typescript-loader.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDatabase} from './helpers/sqlite.mjs';
const {initializeLocalDatabase}=await import('../src/platform/storage/repository.ts');
const {readPlanningInputRevision}=await import('../src/platform/storage/planning-input-revision.ts');
test('personal planning revisions follow actual committed inputs across SQLite connections, excluding drafts and Google bookkeeping',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'liflow-planning-revision-'));const path=join(directory,'plan.db');const a=createDatabase(path);let b;
  try{
    await initializeLocalDatabase(a.database);b=createDatabase(path);const before=await readPlanningInputRevision(a.database);
    b.connection.prepare("UPDATE household_settings SET heavy_daily_limit=heavy_daily_limit+1").run();
    const after=await readPlanningInputRevision(a.database);assert.equal(after,before+1);
    b.connection.exec("BEGIN;UPDATE household_settings SET normal_daily_limit=normal_daily_limit+1;ROLLBACK;");assert.equal(await readPlanningInputRevision(a.database),after);
    b.connection.prepare('INSERT INTO calendar_drafts VALUES(?,?)').run('test','{}');assert.equal(await readPlanningInputRevision(a.database),after);
    b.connection.prepare("INSERT INTO calendar_events VALUES(?,?,1,0)").run('changed','{}');assert.equal(await readPlanningInputRevision(a.database),after+1);
  }finally{b?.connection.close();a.connection.close();rmSync(directory,{recursive:true,force:true});}
});
