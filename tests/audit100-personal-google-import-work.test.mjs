import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createIntegration,repository,now,today} from './helpers/google-sync-integration.mjs';
test('audit100 a hundred personal Tasks status imports capture mapped rows and transactional conflict state in bounded reads',async t=>{
 const h=await createIntegration();t.after(()=>h.connection.close());const originalLinks=await repository.listGoogleTaskLinks(h.database);const links=originalLinks.slice(0,100);assert.equal(links.length,100);
 const changes=links.map(link=>({googleTaskListId:link.googleTaskListId,googleTaskId:link.googleTaskId,scheduleEntryId:link.scheduleEntryId,status:'needsAction'}));
 let reads=0;for(const key of ['getFirstAsync','getAllAsync']){const original=h.database[key];h.database[key]=async(...args)=>{reads++;return original(...args);};}
 assert.equal(await repository.importGoogleTaskChanges(h.database,changes,today,now),0);assert.ok(reads<50,`import snapshot reads ${reads}`);
 const chosen=changes[0];assert.equal(await repository.importGoogleTaskChanges(h.database,[{...chosen,status:'completed',completedAt:now.toISOString()}],today,now),1);
 await repository.acknowledgeGoogleTaskStatus(h.database,links[0],'completed');
 assert.equal(await repository.importGoogleTaskChanges(h.database,[chosen],today,now),1);
 assert.equal((await repository.listGoogleTaskLinks(h.database)).length,originalLinks.length);
});
