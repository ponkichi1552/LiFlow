import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadNativeModule} from './helpers/native-module.mjs';
import {googleFixture} from './helpers/sharing-v2-google.mjs';
test('audit100 repeated private Google link reads reuse validated unchanged rows while caller mutations corruption and revoked scope remain isolated',async()=>{
 const h=await googleFixture();try{await h.connect();await h.sync();const filename='src/platform/storage/sharing-v2-google-tasks.ts',source=new URL('../'+filename,import.meta.url);const mocks={};for(const[,path]of readFileSync(source,'utf8').matchAll(/from ['"]([^'"]+)['"]/gu))if(path.startsWith('.'))mocks[path]=await import(new URL(path.endsWith('.ts')?path:path+'.ts',source));
 let validations=0;const actual=mocks['../../features/sharing/v2/google-tasks-projection.ts'];mocks['../../features/sharing/v2/google-tasks-projection.ts']={...actual,validateV2GoogleTaskTarget:(...args)=>{validations++;return actual.validateV2GoogleTaskTarget(...args);}};
 const {createV2GoogleTaskStore}=loadNativeModule(filename,mocks);const store=createV2GoogleTaskStore(h.scope);const first=await store.readSavedLinks();first[0].lastSyncedTitle='caller mutation';
 for(let i=0;i<50;i++)assert.notEqual((await store.readSavedLinks())[0].lastSyncedTitle,'caller mutation');assert.ok(validations<=first.length*2,`private target validations ${validations}`);
 const raw=h.d.connection.prepare('SELECT * FROM sharing_v2_private_google_links LIMIT 1').get();h.d.connection.prepare('UPDATE sharing_v2_private_google_links SET target_json=? WHERE schedule_entry_id=?').run(JSON.stringify({...JSON.parse(raw.target_json),ownerUserId:'foreign'}),raw.schedule_entry_id);await assert.rejects(store.readSavedLinks());h.d.connection.prepare('UPDATE sharing_v2_private_google_links SET target_json=? WHERE schedule_entry_id=?').run(raw.target_json,raw.schedule_entry_id);assert.equal((await store.readSavedLinks()).length,first.length);h.stop();await assert.rejects(store.readSavedLinks(),/account changed/u);
 }finally{h.close();}
});
