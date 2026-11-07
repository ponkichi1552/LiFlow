import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isVerifiedApplianceAnalysis,isRenderableApplianceAnalysis } from '../src/features/appliance-care/analysis-validation.ts';
import { toApplianceCareChore } from '../src/features/appliance-care/to-chore-definition.ts';
const source='https://www.dyson.co.jp/support/SV20';
const task={name:'清掃',steps:['電源を切って拭く'],tools:[],safetyCautions:[],evidence:[{url:source}],recommendedIntervalDays:30};
const analysis={manufacturer:'Dyson',model:'SV20',analyzedAt:'2026-11-07T00:00:00Z',requiresUserReview:true,tasks:[task]};
test('audit100 new appliance estimates obey the servers positive whole-minute bounds while old zero estimates remain readable and unscheduled as time slots',()=>{
 for(const estimatedMinutes of [0,.5,1441])assert.equal(isVerifiedApplianceAnalysis({...analysis,tasks:[{...task,estimatedMinutes}]},'Dyson'),false,`invalid minutes ${estimatedMinutes}`);
 assert.equal(isVerifiedApplianceAnalysis({...analysis,tasks:[{...task,estimatedMinutes:1}]},'Dyson'),true);
 assert.equal(isRenderableApplianceAnalysis({...analysis,tasks:[{...task,estimatedMinutes:0}]}),true);
 const definition=toApplianceCareChore('old-care','local-household',{applianceId:'appliance',manufacturer:'Dyson',productName:'V12',modelNumber:'SV20',manualUrl:source},analysis,{task:{...task,estimatedMinutes:0}});
 assert.equal(definition.estimatedMinutes,undefined,'old zero is unknown, never an invalid zero-duration planned task');
});
