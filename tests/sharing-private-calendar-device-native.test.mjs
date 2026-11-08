import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { assertSharedIdentifier } from '../src/features/sharing/identifier.ts';

test('private device Native session composition is lazy UID scoped coalesced and never selects a QA Firebase app or group store', async()=>{
  let uid=null; let authReads=0; const calls=[]; const ports=[]; const auth={get currentUser(){return uid?{uid}:null;}}; const firestore={name:'authenticated-live-service'};
  const native={nativePrivateCalendarSecrets:{name:'private-secrets'}};
  for(const [name,kind] of [['RootSetup','roots'],['AuthorityIntents','intents'],['Pairing','candidates'],['Connections','connection-store'],['KeyOutbox','outbox'],['Cache','cache']]) native['nativePrivateCalendar'+name]=owner=>{calls.push([kind,owner]);return{kind,owner};};
  const module=loadNativeModule('src/platform/sharing/private-calendar-devices.ts',{
    './firebase-services':{getSharingServices:()=>{authReads++;return{auth,firestore};}}, './private-calendar-cloud':{createPrivateCalendarCloud:(db,owner,current)=>{
      assert.equal(db,firestore);assert.equal(current(),owner);calls.push(['cloud',owner]);return{kind:'cloud',owner};}}, './native-private-calendar-crypto':{nativePrivateCalendarCrypto:{}},
    './private-calendar-connection-cloud':{createPrivateCalendarConnectionCloud:()=>({kind:'connection-cloud'})},
    './private-calendar-secrets':native,'../../features/sharing/private-calendar/device-session':{createPrivateCalendarDeviceSession:port=>{ports.push(port);return{read:async()=>{await port.assertOwner();return port.userId;}};}},
    '../../features/sharing/identifier':{assertSharedIdentifier},
  });
  assert.equal(authReads,0);assert.equal(calls.length,0);assert.throws(()=>module.openPrivateCalendarDevices('owner-a'),/アカウント/u);assert.equal(calls.length,0);
  uid='owner-a';const first=module.openPrivateCalendarDevices(uid);assert.equal(first,module.openPrivateCalendarDevices(uid));assert.equal(ports.length,1);assert.equal(await first.read(),'owner-a');
  uid='owner-b';await assert.rejects(()=>first.read(),/アカウント/u);assert.throws(()=>module.openPrivateCalendarDevices('owner-a'),/アカウント/u);
  const other=module.openPrivateCalendarDevices(uid);assert.notEqual(other,first);assert.equal(ports.length,2);assert.equal(await other.read(),'owner-b');
  assert.equal(calls.length,14);assert.ok(calls.every(([,owner])=>['owner-a','owner-b'].includes(owner)));uid='owner-a';assert.equal(module.openPrivateCalendarDevices(uid),first);
});

test('private device settings physical preview rejects release and foreign UID contexts before composing a session', async()=>{
  const previous=globalThis.__DEV__;let opened=0;let closed=0;let uid='development-calendar-native-pairing-e2e-v1';const ports=[];
  const module=loadNativeModule('src/platform/sharing/private-calendar-device-preview.ts',{
    './private-calendar-pair-audit':{createPrivateCalendarPairAuditContext:async()=>{opened++;return{userId:uid,intents:{kind:'root-intents'},outbox:{},cache:{},secrets:{},cloud:{},close:async()=>{closed++;}};}},
    './private-calendar-secrets':{developmentPrivateCalendarAuthorityIntents:()=>({kind:'authority-intents'}),developmentPrivateCalendarPairing:()=>({kind:'pairing'})},
    '../../features/sharing/private-calendar/device-session':{createPrivateCalendarDeviceSession:port=>{ports.push(port);return{read:async()=>port.assertOwner()};}},
  });
  try{
    globalThis.__DEV__=false;await assert.rejects(()=>module.createPrivateCalendarDevicePreview('ios','127.0.0.1','8185'),/開発/u);assert.equal(opened,0);
    globalThis.__DEV__=true;uid='real-or-foreign-user';await assert.rejects(()=>module.createPrivateCalendarDevicePreview('ios','127.0.0.1','8185'),/専用/u);assert.equal(closed,1);assert.equal(ports.length,0);
    uid='development-calendar-native-pairing-e2e-v1';const result=await module.createPrivateCalendarDevicePreview('android','127.0.0.1','8185');assert.equal(ports.length,1);assert.equal(ports[0].roots.kind,'root-intents');assert.equal(ports[0].intents.kind,'authority-intents');
    await result.session.read();await result.close();assert.equal(closed,2);globalThis.__DEV__=false;await assert.rejects(()=>result.session.read(),/変わりました/u);
  }finally{globalThis.__DEV__=previous;}
});
