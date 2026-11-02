import { readFileSync, writeFileSync } from 'node:fs';
import { CHORE_CATALOG } from '../src/domain/chores/catalog.ts';

const target = new URL('../docs/housework-guide.md', import.meta.url);
const rows = [
  '# 家事・住まいのお手入れ', '',
  '説明・道具・手順・注意事項・豆知識・実施条件・周期の根拠は、利用者が指定した[36項目のドキュメント](https://docs.google.com/document/d/1_PhiSZxbBkeiIElfg0EezKbn2EVywDN887gWm-QR058/edit)による。目安時間だけは2026年11月1日に指定された36項目の固定時間表を優先する。', '',
  'ドキュメントの幅のある周期を日数へ数値化した値は、アプリの初期設定でありメーカー共通の指定ではない。製品・季節・生活条件で変わる項目にも暫定の初期周期を置き、実際の説明書や使用状況に合わせて変更する。ごみの収集曜日・隔週・毎月の登録機能は引き続き利用できる。', '',
  '組み込み家事は指定された新しい36項目へ置き換える。旧項目の設定・履歴は利用者の指示に従って削除し、旧IDを別の家事へ流用しない。新しい項目は初期状態では無効。', '',
];
for (const [index, chore] of CHORE_CATALOG.entries()) {
  rows.push(`## ${index + 1}. ${chore.name}`, '', `- 分類：${chore.category}`, `- 目安時間：約${chore.estimatedMinutes}分`,
    `- 初期周期：${chore.requiresCycleSelection ? '未設定' : `こまめ ${chore.frequencyDaysByMode.frequent}日／標準 ${chore.frequencyDaysByMode.balanced}日／ゆったり ${chore.frequencyDaysByMode.relaxed}日`}`, '', chore.description, '');
  if (chore.schedulingNotes) rows.push('### 周期・実施条件', '', chore.schedulingNotes, '');
  rows.push('### 必要な道具', '', ...chore.tools.map(tool => `- ${tool}`), '', '### 手順', '');
  if (chore.procedureSections?.length) for (const section of chore.procedureSections) rows.push(`#### ${section.title}`, '', ...section.steps.map((step, i) => `${i + 1}. ${step}`), '');
  else rows.push(...chore.instructions.map((step, i) => `${i + 1}. ${step}`), '');
  rows.push('### 注意事項', '', ...chore.cautions.map(caution => `- ${caution}`), '');
  for (const trivia of chore.trivia ?? []) rows.push(`### 豆知識：${trivia.title}`, '', trivia.body, '');
}
const output = `${rows.join('\n').trimEnd()}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('Regenerate docs/housework-guide.md from the current catalog.');
} else writeFileSync(target, output);
console.log(`${process.argv.includes('--check') ? 'Verified' : 'Generated'} the current guide (${CHORE_CATALOG.length} jobs).`);
