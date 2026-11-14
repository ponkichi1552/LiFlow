import assert from 'node:assert/strict';
import test from 'node:test';
import { applianceDisplayName, appliancePrimaryName, applianceSecondaryLabel } from '../src/features/appliance-care/display-name.ts';

const cases = [
  ['unprefixed product', 'Dyson', 'V12 Detect Slim', 'SV20', 'Dyson V12 Detect Slim（SV20）'],
  ['official brand prefix', 'Dyson', 'Dyson V12 Detect Slim', 'SV20', 'Dyson V12 Detect Slim（SV20）'],
  ['case variation', 'Dyson', 'DYSON V12', 'SV20', 'DYSON V12（SV20）'],
  ['full width prefix', 'Dyson', 'Ｄｙｓｏｎ　V12', 'SV20', 'Ｄｙｓｏｎ　V12（SV20）'],
  ['Japanese brand', 'パナソニック', 'パナソニック ナノケア', 'EH-NA0J', 'パナソニック ナノケア（EH-NA0J）'],
  ['partial prefix stays distinct', 'Dyson', 'Dysonic Cleaner', 'A1', 'Dyson Dysonic Cleaner（A1）'],
  ['brand inside product is retained', 'Dyson', 'Cleaner for Dyson', 'A1', 'Dyson Cleaner for Dyson（A1）'],
  ['candidate without model', 'Dyson', 'Dyson V12', undefined, 'Dyson V12'],
  ['whitespace is trimmed at edges', ' Dyson ', ' V12 ', 'SV20', 'Dyson V12（SV20）'],
  ['empty manufacturer adds no space', '', 'V12', 'SV20', 'V12（SV20）'],
];
for (const [name, manufacturer, productName, modelNumber, expected] of cases) {
  test(`appliance label: ${name}`, () => {
    const product = Object.freeze({ manufacturer, productName, modelNumber });
    assert.equal(applianceDisplayName(product), expected);
  });
}

test('only automatically generated saved names are reformatted', () => {
  const product = { manufacturer: 'Dyson', productName: 'Dyson V12', modelNumber: 'SV20' };
  assert.equal(applianceDisplayName(product, 'Dyson Dyson V12（SV20）'), 'Dyson V12（SV20）');
  assert.equal(applianceDisplayName(product, 'リビングの掃除機'), 'リビングの掃除機');
  assert.equal(applianceDisplayName(product, ''), '');
});

test('appliance subtitles retain missing product details and avoid repeating the visible name', () => {
  assert.equal(applianceSecondaryLabel('Dyson V12（SV20）', ['Dyson', 'SV20']), '');
  assert.equal(applianceSecondaryLabel('Ｄｙｓｏｎ　V12（ＳＶ２０）', ['Dyson', 'SV20']), '');
  assert.equal(applianceSecondaryLabel('リビングの掃除機', ['Dyson', 'SV20']), 'Dyson · SV20');
  assert.equal(applianceSecondaryLabel('Dyson V12（SV20）', ['掃除機', 'SV20']), '掃除機');
  assert.equal(applianceSecondaryLabel('掃除機', [undefined, '', 'Dyson', 'dyson']), 'Dyson');
  assert.equal(applianceSecondaryLabel('Dysonic SV200', ['Dyson', 'SV20']), 'Dyson · SV20');
});

test('appliance kinds lead while reviewed product identity and custom names remain available', () => {
  assert.equal(appliancePrimaryName({ category: 'washing_machine', productName: 'NA-TEST' }, 'Panasonic NA-TEST'), '洗濯機');
  assert.equal(appliancePrimaryName({ productName: '衣類乾燥機' }, 'Test Dryer'), '衣類乾燥機');
  const product = { productName: 'V12 Detect Slim', displayName: '居間用', analysis: { tasks: [{ name: 'クリアビンのゴミ捨て' }] } };
  const before = structuredClone(product);
  assert.equal(appliancePrimaryName(product, '居間用'), '掃除機'); assert.deepEqual(product, before);
  assert.equal(applianceSecondaryLabel('掃除機', ['Dyson V12（SV20）', 'Dyson', 'SV20']), 'Dyson V12（SV20）');
  assert.equal(appliancePrimaryName({ productName: '不明', analysis: { tasks: [{ name: '本体の清掃' }] } }, '保存した製品名'), '保存した製品名');
  assert.equal(appliancePrimaryName({ category: 'washing_machine', analysis: product.analysis }, '洗濯機の元の名前'), '洗濯機');
});
