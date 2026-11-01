import { readFileSync, writeFileSync } from 'node:fs';
import { CHORE_CATALOG, HOUSEHOLD_CARE_IDS } from '../src/domain/chores/catalog.ts';

const target = new URL('../docs/housework-guide.md', import.meta.url);
const rows = [
  '# 家事・住まいのお手入れ', '',
  '説明・道具・手順・注意事項・豆知識・実施条件・周期の根拠は、利用者が指定した[36項目のドキュメント](https://docs.google.com/document/d/1_PhiSZxbBkeiIElfg0EezKbn2EVywDN887gWm-QR058/edit)による。目安時間だけは2026年11月1日に指定された36項目の固定時間表を優先する。', '',
  'ドキュメントの幅のある周期を日数へ数値化した値は、アプリの初期設定でありメーカー共通の指定ではない。使用ごと・季節前・製品固有・自治体指定など一律の固定周期を決められない項目は、周期未設定とする。ごみの収集曜日・隔週・毎月の登録機能は引き続き利用できる。', '',
  '今回の36項目に含まれない既存の食器洗い・日常の水滴取り等10項目も保持する。既存の家事のID・履歴・個別設定を別の家事へ流用しない。追加される26項目は初期状態では無効。', '',
];
for (const [index, chore] of CHORE_CATALOG.entries()) {
  if (index === HOUSEHOLD_CARE_IDS.length) rows.push('## 保持する既存項目', '');
  rows.push(`## ${index + 1}. ${chore.name}`, '', `- 分類：${chore.category}`, `- 目安時間：約${chore.estimatedMinutes}分`,
    `- 初期周期：${chore.requiresCycleSelection ? '未設定' : `こまめ ${chore.frequencyDaysByMode.frequent}日／標準 ${chore.frequencyDaysByMode.balanced}日／ゆったり ${chore.frequencyDaysByMode.relaxed}日`}`, '', chore.description, '');
  if (chore.schedulingNotes) rows.push('### 周期・実施条件', '', chore.schedulingNotes, '');
  rows.push('### 必要な道具', '', ...chore.tools.map(tool => `- ${tool}`), '', '### 手順', '');
  if (chore.procedureSections?.length) for (const section of chore.procedureSections) rows.push(`#### ${section.title}`, '', ...section.steps.map((step, i) => `${i + 1}. ${step}`), '');
  else rows.push(...chore.instructions.map((step, i) => `${i + 1}. ${step}`), '');
  rows.push('### 注意事項', '', ...chore.cautions.map(caution => `- ${caution}`), '');
  for (const trivia of chore.trivia ?? []) rows.push(`### 豆知識：${trivia.title}`, '', trivia.body, '');
  if (chore.sourceNotes?.length) rows.push('### 参照元', '', ...chore.sourceNotes.map(url => `- ${url}`), '');
}
const output = `${rows.join('\n').trimEnd()}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('Regenerate docs/housework-guide.md from the current catalog.');
} else writeFileSync(target, output);
console.log(`${process.argv.includes('--check') ? 'Verified' : 'Generated'} the current guide (${CHORE_CATALOG.length} jobs).`);
