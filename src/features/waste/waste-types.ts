export interface WasteType {
  label: string;
  aliases: readonly string[];
}

/** Municipality names vary, so the form also accepts an explicitly selected custom label. */
export const WASTE_TYPES: readonly WasteType[] = [
  { label: '可燃ごみ', aliases: ['かねん', 'もえるごみ', '燃えるごみ', '燃やせるごみ', '普通ごみ'] },
  { label: '不燃ごみ', aliases: ['ふねん', 'もえないごみ', '燃えないごみ', '燃やせないごみ'] },
  { label: '資源ごみ', aliases: ['しげん', 'リサイクル'] },
  { label: 'びん', aliases: ['瓶', 'ビン', 'ガラスびん', '空きびん'] },
  { label: '缶', aliases: ['かん', 'カン', '空き缶', 'アルミ缶', 'スチール缶'] },
  { label: 'びん・缶', aliases: ['びんかん', '瓶缶', 'ビンカン'] },
  { label: 'ペットボトル', aliases: ['ぺっとぼとる', 'PET'] },
  { label: 'プラスチック資源', aliases: ['ぷら', 'プラごみ', 'プラスチックごみ'] },
  { label: '容器包装プラスチック', aliases: ['ようきほうそう', '容器包装', 'プラ容器', 'トレー'] },
  { label: '製品プラスチック', aliases: ['せいひんぷらすちっく', '製品プラ'] },
  { label: '古紙', aliases: ['こし', 'ふるかみ', '紙ごみ'] },
  { label: '新聞', aliases: ['しんぶん', '新聞紙'] },
  { label: '雑誌', aliases: ['ざっし', '本', '書籍'] },
  { label: '段ボール', aliases: ['だんぼーる', 'ダンボール'] },
  { label: '紙パック', aliases: ['かみぱっく', '牛乳パック'] },
  { label: '雑がみ', aliases: ['ざつがみ', '雑紙', '紙箱'] },
  { label: '古布・衣類', aliases: ['ふるぬの', 'こふ', 'いるい', '衣服', '古着', 'ふるぎ'] },
  { label: '小型家電', aliases: ['こがたかでん', '家電', '電化製品'] },
  { label: '乾電池', aliases: ['かんでんち', '電池', 'でんち', 'ボタン電池'] },
  { label: '充電池', aliases: ['じゅうでんち', 'リチウムイオン電池', 'モバイルバッテリー'] },
  { label: '蛍光灯', aliases: ['けいこうとう', '蛍光管', '電球', 'でんきゅう'] },
  { label: '有害ごみ', aliases: ['ゆうがい', '水銀', '体温計'] },
  { label: '危険ごみ', aliases: ['きけん', '刃物', 'ライター'] },
  { label: 'スプレー缶', aliases: ['すぷれー', 'カセットボンベ', 'エアゾール缶'] },
  { label: '金属類', aliases: ['きんぞく', '鍋', 'フライパン'] },
  { label: '粗大ごみ', aliases: ['そだい', '大型ごみ', '家具'] },
  { label: '剪定枝', aliases: ['せんていし', 'せんていえだ', '枝', 'えだ', '草木'] },
  { label: '落ち葉・草', aliases: ['おちば', 'くさ', '葉', '刈草'] },
  { label: '生ごみ', aliases: ['なまごみ', '食品くず', '厨芥'] },
  { label: '陶磁器・ガラス', aliases: ['とうじき', 'がらす', 'せともの', '割れ物'] },
  { label: '発泡スチロール', aliases: ['はっぽうすちろーる', 'はっぽう'] },
  { label: '使用済み食用油', aliases: ['しょくようあぶら', '廃食油', 'はいしょくゆ', '油'] },
];

export function normalizeWasteTypeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP')
    .replace(/[ァ-ヶ]/gu, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60))
    .replace(/[\s・･、]/gu, '').replace(/ごみ/gu, '');
}

const indexedWasteTypes = WASTE_TYPES.map((item, index) => ({ item, index, terms: [item.label, ...item.aliases].map(normalizeWasteTypeText) }));
const exactWasteTypes = new Map<string, number>();
for (const { terms, index } of indexedWasteTypes) for (const term of terms) if (!exactWasteTypes.has(term)) exactWasteTypes.set(term, index);
export function wasteTypeIndex(label: string): number { return exactWasteTypes.get(normalizeWasteTypeText(label)) ?? -1; }

export function searchWasteTypes(query: string): readonly WasteType[] {
  const normalized = normalizeWasteTypeText(query.trim());
  if (!query.trim()) return [];
  if (!normalized) return WASTE_TYPES;
  return indexedWasteTypes.flatMap(({ item, index, terms }) => {
    const rank = terms.some((term) => term === normalized) ? 0
      : terms.some((term) => term.startsWith(normalized)) ? 1
        : terms.some((term) => term.includes(normalized)) ? 2 : -1;
    return rank < 0 ? [] : [{ item, rank, index }];
  }).sort((left, right) => left.rank - right.rank || left.index - right.index).map(({ item }) => item);
}
