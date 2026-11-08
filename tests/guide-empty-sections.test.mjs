import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

for (const platform of ['ios', 'android']) test(`${platform} an empty guide omits unused sections while its plan action and later supplied content remain usable`, async () => {
  let changed = 0;
  const chore = { id: 'custom', name: '追加した家事', category: '追加した家事', recommendedCycleDays: 30,
    estimatedMinutes: 15, effort: 'normal', instructions: [' '], tools: ['\n'], cautions: [' '],
    procedureSections: [{ title: '見出しだけ', steps: [' '] }], description: '', schedulingNotes: '' };
  const original = structuredClone(chore);
  const screen = screenHarness('src/features/chores/chore-guide.tsx', { exportName: 'ChoreGuide', platform, props: { chore, mode: 'balanced',
    procedureAction: { type: 'Pressable', props: { accessibilityRole: 'button', accessibilityLabel: '予定の有効化', onPress: () => { changed++; }, children: '予定に追加' } } } });
  for (const title of ['家事の手順', '必要な道具', '注意事項', '手順はまだ登録されていません。']) assert.ok(!screen.text().includes(title));
  await screen.press('予定の有効化'); assert.equal(changed, 1); assert.deepEqual(chore, original);
  chore.instructions = ['外装を拭く']; chore.tools = ['布']; chore.cautions = ['電源を切る']; screen.render();
  for (const value of ['家事の手順', '外装を拭く', '必要な道具', '布', '注意事項', '電源を切る']) assert.ok(screen.text().includes(value));
  assert.ok(!screen.text().includes('見出しだけ'));
  await screen.press('予定の有効化'); assert.equal(changed, 2);
  chore.procedureSections = [{ title: '準備', steps: ['電源プラグを抜く'] }]; screen.render();
  assert.ok(screen.text().includes('準備')); assert.ok(screen.text().includes('電源プラグを抜く'));
});
