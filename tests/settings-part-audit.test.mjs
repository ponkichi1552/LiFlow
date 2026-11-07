import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalCapacityEditor } from '../src/features/settings/personal-capacity-editor.ts';
import { createChoreSettingsEditor } from '../src/features/settings/chore-settings-editor.ts';
import { applyChoreSettingsPatch } from '../src/domain/chores/settings-patch.ts';

test('a failed navigation callback cannot freeze an autosaved settings form or block the next navigation',async()=>{
  const editor=createPersonalCapacityEditor({initial:{allowedBands:[],dayOverrides:[]},save:async()=>{},delayMs:60000});
  await assert.rejects(editor.navigateAfterSave(()=>{throw new Error('navigator unavailable');}),/navigator unavailable/);
  editor.change(raw=>({...raw,maximum:'30'}));assert.equal(editor.getSnapshot().raw.maximum,'30');
  let moved=0;assert.equal(await editor.navigateAfterSave(()=>moved++),true);assert.equal(moved,1);
});
test('editing an already saved appliance cycle does not falsely disable the chore while a replacement number is incomplete',async()=>{
  const initial={id:'appliance-choice',householdId:'local-household',applianceId:'appliance',name:'お手入れ',enabled:false,requiresCycleSelection:true,
    load:'light',frequencyDaysByMode:{},windowRadiusDays:1,holidayPriority:false};let saved=initial;
  const editor=createChoreSettingsEditor(initial,'balanced',async patch=>{saved=applyChoreSettingsPatch(saved,patch);});
  editor.changeCycle('7');await editor.flush();assert.equal(saved.enabled,true);
  editor.changeCycle('a');assert.equal(editor.getSnapshot().draft.enabled,true,'an incomplete number is not a disable command');
  assert.equal(saved.enabled,true);editor.changeCycle('14');await editor.flush();assert.equal(saved.enabled,true);assert.equal(saved.userIntervalDays,14);
});
