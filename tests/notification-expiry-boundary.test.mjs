import './helpers/typescript-loader.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {loadNativeModule} from './helpers/native-module.mjs';
import {reconcileLocalNotifications} from '../src/features/notifications/reconcile-local-notifications.ts';
import {ExpiredNotificationRequestError} from '../src/features/notifications/expired-request.ts';

test('a replacement expiring before native scheduling cancels the superseded reminder instead of leaving its old time armed',async()=>{
  const old={key:'reminder.same-round',title:'Housework',body:'Old time',fireAt:'2026-11-07T11:00:00Z'};
  const pending=new Map([[old.key,old]]);let checks=0;
  const gateway={getScheduledRequests:async()=>[...pending.values()],hasPermission:async()=>true,
    schedule:async()=>{throw new ExpiredNotificationRequestError();},cancel:async key=>pending.delete(key)};
  const result=await reconcileLocalNotifications(gateway,{prefix:'reminder.',enabled:true,
    desired:[{...old,body:'New time',fireAt:'2026-11-07T09:00:00Z'}],assertCurrent:()=>{checks++;}});
  assert.equal(pending.size,0,'a superseded future reminder must not fire at its old time');
  assert.equal(result.deadlineExcluded,1);assert.equal(result.cancelled,1);assert.equal(result.failed,0);
  assert.ok(checks>=4,'authority is rechecked before native cancellation');
});
test('a reminder expiring during the final native deadline read is never passed to the OS as an immediate request',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-07T08:59:59Z')});let sent=0;
  const {ExpoLocalNotificationGateway}=loadNativeModule('src/platform/notifications/expo-local-notification-gateway.ts',{
    'react-native':{Platform:{OS:'ios'}},'expo-notifications':{SchedulableTriggerInputTypes:{DATE:'date'},scheduleNotificationAsync:async()=>{sent++;return'id';}},
  });
  const gateway=new ExpoLocalNotificationGateway();gateway.schedulingDeadline=async()=>{t.mock.timers.setTime(Date.parse('2026-11-07T09:00:01Z'));return Infinity;};
  await assert.rejects(gateway.schedule({key:'notice',title:'Housework',body:'Today',fireAt:'2026-11-07T09:00:00Z'}),{name:'ExpiredNotificationRequestError'});assert.equal(sent,0);
});
