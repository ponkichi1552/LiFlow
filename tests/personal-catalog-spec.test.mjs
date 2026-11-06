import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadNativeModule } from './helpers/native-module.mjs';
const { PERSONAL_CHORE_CATALOG: recipes, PERSONAL_CHORE_CATALOG_SOURCE_SHA256: digest, personalRecipeInitialDays,
  initialPersonalChoreSelection, togglePersonalCatalogSelection, createPersonalChoreDefinitions, personalChoreHistoryPolicy,
  personalChoreCadenceLabel, personalOnboardingChores, planPersonalCatalogToggles } = loadNativeModule('src/domain/chores/personal-catalog.ts', {
  './personal-catalog-data.json': JSON.parse(readFileSync(new URL('../src/domain/chores/personal-catalog-data.json', import.meta.url), 'utf8')),
  '../scheduling/adaptive/placement.ts': await import('../src/domain/scheduling/adaptive/placement.ts'),
  './cycle-policy.ts': await import('../src/domain/chores/cycle-policy.ts'),
});
const source = readFileSync(new URL('../docs/specifications/housework-catalog-2026-11-04.md', import.meta.url), 'utf8');
const recipe = name => { const value = recipes.find(value => value.name === name); assert.ok(value, name); return value; };
const { applyChoreSettingsPatch } = await import('../src/domain/chores/settings-patch.ts');

test('new catalog definitions preserve non-periodic modes through JSON and reset without inventing daily tasks or losing selection and guide data', () => {
  const definitions = createPersonalChoreDefinitions('local-household');
  assert.equal(definitions.length, recipes.filter(row => row.availability === 'available' && row.modes.balanced.kind !== 'collection').length);
  assert.equal(definitions.filter(row => row.enabled).length, 8);
  const blanket = definitions.find(row => row.name === '毛布の洗濯');
  const roundTrip = JSON.parse(JSON.stringify(blanket));
  assert.deepEqual(roundTrip.frequencyDaysByMode, { frequent: 90, balanced: 180 });
  assert.equal(personalChoreHistoryPolicy(roundTrip, 'relaxed').initialDays.relaxed, null);
  assert.equal(personalChoreCadenceLabel(roundTrip, 'relaxed'), recipe('毛布の洗濯').cadenceLabels.relaxed);
  const changed = applyChoreSettingsPatch(roundTrip, { enabled: true, cycleDays: 20, load: 'heavy', windowRadiusDays: 5 });
  const reset = applyChoreSettingsPatch(changed, { resetSchedule: true });
  assert.equal(reset.recommendedCycleDays, undefined); assert.equal(reset.userWindowRadiusDays, undefined); assert.equal(reset.enabled, true);
  assert.equal(reset.load, blanket.load); assert.deepEqual(reset.instructions, blanket.instructions);
  const needed = { ...definitions.find(row => row.name === '調理後の片付け'), enabled: true };
  assert.deepEqual(needed.frequencyDaysByMode, {});
  assert.deepEqual(personalChoreHistoryPolicy(needed, 'balanced').initialDays, { frequent: null, balanced: null, relaxed: null });
  const longFixed = applyChoreSettingsPatch(blanket, { cycleDays: 10_000 });
  assert.equal(longFixed.recommendedCycleDays, 10_000);
  assert.throws(() => applyChoreSettingsPatch(blanket, { cycleDays: Number.MAX_SAFE_INTEGER + 1 }));
});

test('personal catalog contains all 81 adopted recipes with source work time load tools steps and cautions and no app reference links', () => {
  execFileSync(process.execPath, ['scripts/build-personal-chore-catalog.mjs', '--check']);
  assert.equal(recipes.length, 81); assert.equal(new Set(recipes.map(row => row.id)).size, 81);
  assert.equal(digest, createHash('sha256').update(source).digest('hex'));
  const guides = [...source.matchAll(/^### ([^\n]+)\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/gmu)];
  assert.deepEqual(recipes.map(row => row.name), guides.map(row => row[1]));
  for (const row of recipes) {
    const guide = guides.find(value => value[1] === row.name)[2];
    const load = /負荷の目安：(軽い|普通|重い)/u.exec(guide)[1];
    assert.equal(row.load, { 軽い: 'light', 普通: 'normal', 重い: 'heavy' }[load]);
    assert.equal(row.estimatedMinutes, Number(/実作業の目安：(\d+)分/u.exec(guide)[1]));
    assert.ok(row.estimatedMinutes > 0 && row.tools.length && row.cautions.length && row.instructions.length);
    const instructions = guide.split('**手順**')[1].split('**注意事項**')[0];
    assert.equal(row.instructions.length, [...instructions.matchAll(/^\d+\. /gmu)].length);
    assert.doesNotMatch(JSON.stringify(row), /https?:\/\/|参考：/u);
  }
  assert.match(recipe('浴室の清掃').instructions.at(-1), /カビがある場合だけ/u);
});
test('personal catalog enables only the eight basic jobs and never creates a numeric surrogate for usage needed seasonal held or collection entries', () => {
  assert.deepEqual(initialPersonalChoreSelection().map(id => recipes.find(row => row.id === id).name),
    ['部屋の清掃', '浴室の清掃', 'トイレの清掃', '洗面台の清掃', 'シンクの清掃', '玄関の清掃', '衣類・タオルの洗濯', '寝具カバーの交換・洗濯']);
  for (const name of ['ごみ・資源の収集日に合わせたごみ出し', '追いだき配管の洗浄', '枕本体の洗濯', '調理後の片付け', '加湿器タンクの手入れ', '季節衣類のしまい洗い・収納']) {
    for (const mode of ['frequent', 'balanced', 'relaxed']) assert.equal(personalRecipeInitialDays(recipe(name), mode), undefined);
    assert.equal(recipe(name).initialEnabled, false);
  }
  assert.equal(recipe('追いだき配管の洗浄').availability, 'held');
  assert.equal(personalRecipeInitialDays(recipe('毛布の洗濯'), 'frequent'), 90);
  assert.equal(personalRecipeInitialDays(recipe('毛布の洗濯'), 'balanced'), 180);
  assert.equal(personalRecipeInitialDays(recipe('毛布の洗濯'), 'relaxed'), undefined);
  assert.equal(personalRecipeInitialDays(recipe('窓まわりの清掃'), 'relaxed'), 365);
});
test('personal catalog explicit splits replace only their known parent without inventing siblings remainder work or inferred shared completion', () => {
  const before = initialPersonalChoreSelection(); const child = recipe('タオルだけの洗濯'); const parent = recipe('衣類・タオルの洗濯');
  const next = togglePersonalCatalogSelection(before, child.id, true);
  assert.deepEqual(new Set(next), new Set([...before.filter(id => id !== parent.id), child.id]));
  assert.equal(next.includes(recipe('衣類だけの洗濯').id), false);
  const restored = togglePersonalCatalogSelection(next, parent.id, true); assert.deepEqual(new Set(restored), new Set(before));
  const shoe = togglePersonalCatalogSelection(before, recipe('靴箱内部の清掃').id, true);
  assert.ok(shoe.includes(recipe('玄関の清掃').id));
  const covers = recipe('寝具カバーの交換・洗濯'); const pillow = recipe('枕カバーの交換・洗濯');
  assert.equal(covers.estimatedMinutes, 20); assert.equal(pillow.estimatedMinutes, 5);
  assert.equal(recipe('シーツの交換・洗濯').estimatedMinutes + recipe('掛け布団カバーの交換・洗濯').estimatedMinutes + pillow.estimatedMinutes, 25);
  assert.equal(before.length, 8, 'selection helpers never mutate the input');
});
test('personal catalog alternative net cleaning does not double count its normal target and integrated filters retain their source parent work', () => {
  const parent = recipe('窓まわりの清掃'); const net = recipe('網戸の通常清掃'); const deep = recipe('網戸を外して行う清掃'); const glass = recipe('窓ガラスだけの清掃');
  const selected = togglePersonalCatalogSelection([net.id, glass.id], deep.id, true);
  assert.deepEqual(new Set(selected), new Set([deep.id, glass.id]));
  assert.deepEqual(togglePersonalCatalogSelection(selected, parent.id, true), [parent.id]);
  assert.ok(recipe('洗濯機の糸くずフィルター清掃').integratedInto.includes(recipe('衣類・タオルの洗濯').id));
  assert.ok(recipe('炊飯器の使用後手入れ').integratedInto.includes(recipe('調理後の片付け').id));
  assert.throws(() => togglePersonalCatalogSelection([], recipe('追いだき配管の洗浄').id, true));
  assert.throws(() => togglePersonalCatalogSelection([], recipe('ごみ・資源の収集日に合わせたごみ出し').id, true));
});

test('personal first setup offers only the eight basic jobs while explicit alternative bulk activation rejects duplicate work atomically', () => {
  const definitions = createPersonalChoreDefinitions('personal');
  const onboarding = personalOnboardingChores(definitions.map(chore => ({ ...chore, enabled: false })));
  assert.deepEqual(onboarding.map(chore => chore.id), initialPersonalChoreSelection());
  const legacy = { ...definitions[0], id: 'custom-job', personalRecipeId: undefined };
  assert.ok(personalOnboardingChores([...definitions, legacy]).some(chore => chore.id === legacy.id));
  assert.equal(personalOnboardingChores([{ ...legacy, requiresCycleSelection: true }]).length, 0);
  const parent = recipe('衣類・タオルの洗濯').id; const child = recipe('タオルだけの洗濯').id;
  assert.deepEqual(new Set(planPersonalCatalogToggles(['custom-job', parent], [child], true)), new Set(['custom-job', child]));
  assert.throws(() => planPersonalCatalogToggles(['custom-job'], [parent, child], true), /どちらか一方/u);
  assert.throws(() => planPersonalCatalogToggles([], [child, parent], true), /どちらか一方/u);
});
test('personal catalog generation rejects an unspecified cadence instead of fabricating a one-day or zero-minute fallback', t => {
  const dir = mkdtempSync(join(tmpdir(), 'liflow-personal-catalog-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['scripts', 'docs/specifications', 'src/domain/chores']) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'scripts/build-personal-chore-catalog.mjs'), readFileSync(new URL('../scripts/build-personal-chore-catalog.mjs', import.meta.url)));
  writeFileSync(join(dir, 'docs/specifications/housework-catalog-2026-11-04.md'), source.replace('| 3日に1回 |', '| 未指定の周期 |'));
  assert.throws(() => execFileSync(process.execPath, ['scripts/build-personal-chore-catalog.mjs'], { cwd: dir, stdio: 'pipe' }), /Unspecified cadence/u);
});
