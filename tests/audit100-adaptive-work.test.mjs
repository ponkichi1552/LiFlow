import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { chooseAdaptiveMethod } = await import('../src/domain/scheduling/adaptive/models.ts');
test('audit100 adaptive method selection reads only the latest comparable forecast scores instead of full history', () => {
  let reads=0; const scores=Array.from({length:2000},(_,n)=>({get epoch(){reads++;return 'epoch';},completionId:`done-${n}`,errors:{median:4,exponential:1,weekly:2,monthEnd:3,alternating:2}}));
  assert.equal(chooseAdaptiveMethod('median',scores,'epoch',['median','exponential','weekly','monthEnd','alternating']),'exponential');
  assert.ok(reads<=16,`forecast score reads: ${reads}`);
});
