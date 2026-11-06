import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = new URL('../docs/specifications/housework-catalog-2026-11-04.md', import.meta.url);
const output = new URL('../src/domain/chores/personal-catalog-data.json', import.meta.url);
const document = readFileSync(source, 'utf8');
const table = document.slice(0, document.indexOf('# 3モードの周期を選んだ理由'));
const rows = []; let tableGroup;
for (const line of table.split('\n')) {
  if (line.startsWith('## ')) tableGroup = line.slice(3);
  if (!line.startsWith('|')) continue;
  const cells = line.replace(/^\||\|$/gu, '').split('|').map(value => value.trim());
  if (cells.length >= 5 && /^\d+分$/u.test(cells[4])) rows.push({ tableGroup, cells });
}
const guides = [...document.matchAll(/^### ([^\n]+)\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/gmu)].map(match => ({ name: match[1].trim(), body: match[2] }));
if (rows.length !== 81 || guides.length !== 81 || new Set(rows.map(row => row.cells[0])).size !== 81) throw new Error('The adopted catalog must have exactly 81 unique rows and guides.');
const basic = ['部屋の清掃', '浴室の清掃', 'トイレの清掃', '洗面台の清掃', 'シンクの清掃', '玄関の清掃', '衣類・タオルの洗濯', '寝具カバーの交換・洗濯'];
const numeric = new Map(Object.entries({ '2日に1回': 2, '3日に1回': 3, '週1回': 7, '2週間に1回': 14,
  '月1回': 30, '2か月に1回': 60, '3か月に1回': 90, '半年に1回': 180, '年1回': 365 }));
const needed = new Set(['必要時', '収納前・汚れ時', '汗が染みた時・汚れやにおい時', '使用前又は洗濯後の必要時', 'カビを見つけた時', '通常清掃で落ちない汚れがある時']);
const afterUse = new Set(['乾燥使用後ごと', '使用後ごと', '洗濯後ごと', '浴槽使用後ごと', '炊飯・保温後ごと', '調理・食後ごと', '調理後ごと', '食後ごと', '使用日は毎日、水を入れ替える時']);
function cadence(raw) {
  if (raw === '設定した収集日') return { kind: 'collection' };
  if (raw === '年2回の季節切替時') return { kind: 'seasonal', seasonalTask: 'clothingStorage' };
  if (raw === '月1回・収録判断は保留') return { kind: 'held' };
  if (needed.has(raw)) return { kind: 'asNeeded' };
  if (afterUse.has(raw)) return { kind: 'afterUse' };
  const value = raw.replace(/^使用中/u, '').replace(/＋収納前$|又は収納前$|・対応機種の任意工程$/gu, '');
  if (!numeric.has(value)) throw new Error(`Unspecified cadence: ${raw}`);
  return { kind: 'days', days: numeric.get(value) };
}
function plain(text) {
  return text.replace(/\[[^\]]*\]\(https?:\/\/[^)]+\)/gu, '').replace(/https?:\/\/\S+/gu, '')
    .replace(/\*\*/gu, '').replace(/[ \t]+$/gmu, '').trim();
}
function items(text, numbered = false) {
  const marker = numbered ? /^\d+\.\s+/u : /^-\s+/u; const result = [];
  for (const line of text.split('\n')) {
    if (/^参考[：:]/u.test(line.trim()) || !line.trim()) continue;
    if (marker.test(line)) { const value = plain(line.replace(marker, '')); if (value) result.push(value); }
    else if (result.length) result[result.length - 1] += `\n${plain(line)}`;
    else throw new Error(`Unstructured guide content: ${line}`);
  }
  return result;
}
const splitParents = {
  '部屋の床だけの清掃': '部屋の清掃', '家具・棚のほこり取り': '部屋の清掃',
  '浴槽だけの清掃': '浴室の清掃', '浴室排水口の洗浄': '浴室の清掃', '浴槽・排水口以外の浴室の清掃': '浴室の清掃',
  'シンクの排水口・ごみかごだけの洗浄': 'シンクの清掃', '排水口以外のシンク本体の清掃': 'シンクの清掃',
  '窓ガラスだけの清掃': '窓まわりの清掃', '網戸の通常清掃': '窓まわりの清掃', 'サッシ・レールの清掃': '窓まわりの清掃',
  '衣類だけの洗濯': '衣類・タオルの洗濯', 'タオルだけの洗濯': '衣類・タオルの洗濯',
  '枕カバーの交換・洗濯': '寝具カバーの交換・洗濯', 'シーツの交換・洗濯': '寝具カバーの交換・洗濯', '掛け布団カバーの交換・洗濯': '寝具カバーの交換・洗濯',
  '食器・調理器具の洗浄': '調理後の片付け', '調理台・コンロの軽い清掃': '調理後の片付け',
  '厚手カーテンの洗濯': 'カーテンの洗濯', 'レースカーテンの洗濯': 'カーテンの洗濯', '靴箱内部の清掃': '玄関の清掃',
};
const integrated = {
  '洗濯機の糸くずフィルター清掃': ['衣類・タオルの洗濯', '衣類だけの洗濯', 'タオルだけの洗濯'],
  '洗濯機の乾燥フィルター清掃': ['衣類・タオルの洗濯', '衣類だけの洗濯', 'タオルだけの洗濯'],
  '槽乾燥の操作': ['洗濯槽のお手入れ'], '食洗機の残さいフィルター清掃': ['調理後の片付け'],
  '炊飯器の使用後手入れ': ['調理後の片付け'], '浴室のカビ取り': ['浴室の清掃'],
  '頑固な水あか落とし': ['浴室の清掃', '洗面台の清掃', 'シンクの清掃'], 'ごみ箱の清掃': ['ごみ・資源の収集日に合わせたごみ出し'],
};
const ids = new Map(rows.map(({ cells }, i) => [cells[0], `liflow-catalog-6.${String(i + 1).padStart(3, '0')}`]));
for (const name of [...Object.keys(splitParents), ...Object.keys(integrated)]) if (!ids.has(name)) throw new Error(`Relationship names an undefined recipe: ${name}`);
function refs(names = []) { return names.map(name => { const id = ids.get(name); if (!id) throw new Error(`Missing named recipe: ${name}`); return id; }); }
const recipes = rows.map(({ tableGroup, cells }, index) => {
  const [name, frequent, balanced, relaxed, minutes, scope] = cells;
  const guide = guides.find(value => value.name === name); if (!guide) throw new Error(`Missing guide: ${name}`);
  const match = /^\*\*負荷の目安：(軽い|普通|重い)\*\*[^\n]*実作業の目安：(\d+)分\s*\n([\s\S]*?)\*\*必要な道具\*\*([\s\S]*?)\*\*手順\*\*([\s\S]*?)\*\*注意事項\*\*([\s\S]*)$/u.exec(guide.body.trim());
  if (!match || Number(match[2]) !== Number(minutes.replace('分', ''))) throw new Error(`Incomplete guide or conflicting work time: ${name}`);
  const end = match[6].split('**豆知識・手入れのコツ**');
  const tips = end[1] ? items(end[1]).map((body, i) => ({ id: `${ids.get(name)}.tip-${i + 1}`, body })) : [];
  const modes = { frequent: cadence(frequent), balanced: cadence(balanced), relaxed: cadence(relaxed) };
  const held = Object.values(modes).some(value => value.kind === 'held');
  if (tableGroup === '分割した場合の初期値' && !splitParents[name]) throw new Error(`Unspecified split relation: ${name}`);
  const recipe = { id: ids.get(name), name, category: tableGroup, scope: scope ?? name,
    estimatedMinutes: Number(match[2]), load: { 軽い: 'light', 普通: 'normal', 重い: 'heavy' }[match[1]],
    loadExplanation: plain(match[3]), modes, cadenceLabels: { frequent, balanced, relaxed },
    initialEnabled: basic.includes(name), availability: held ? 'held' : 'available',
    splitParentId: splitParents[name] ? refs([splitParents[name]])[0] : null,
    // The entry's normal scope is the entrance floor; the optional shoe cabinet is already separate.
    exclusiveWithParent: Boolean(splitParents[name]) && name !== '靴箱内部の清掃',
    replacesRecipeIds: name === '網戸を外して行う清掃' ? refs(['窓まわりの清掃', '網戸の通常清掃']) : [],
    integratedInto: refs(integrated[name]), tools: items(match[4]), instructions: items(match[5], true), cautions: items(end[0]), trivia: tips };
  if (!recipe.tools.length || !recipe.instructions.length || !recipe.cautions.length || !Number.isSafeInteger(recipe.estimatedMinutes) || recipe.estimatedMinutes <= 0) throw new Error(`Incomplete recipe: ${name}`);
  return recipe;
});
const value = JSON.stringify({ schemaVersion: 1, catalogVersion: 6, specificationVersion: '2026-11-04',
  sourceSha256: createHash('sha256').update(document).digest('hex'), recipes }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== value) throw new Error('The personal catalog is stale. Regenerate it from the adopted specification.');
} else writeFileSync(output, value);
console.log(`Personal catalog: ${recipes.length} recipes, ${recipes.filter(row => row.initialEnabled).length} initially enabled; ${fileURLToPath(output)}`);
