export interface ApplianceCategoryOption {
  value: string;
  label: string;
  aliases: readonly string[];
}

/** Japanese labels are for people; stable English ids are stored and sent to the API. */
export const applianceCategoryOptions: readonly ApplianceCategoryOption[] = [
  { value: 'air_conditioner', label: 'エアコン', aliases: ['冷房', '暖房', '空調', 'えあこん'] },
  { value: 'air_purifier', label: '空気清浄機', aliases: ['空清'] },
  { value: 'dehumidifier', label: '除湿機', aliases: ['除湿'] },
  { value: 'dishwasher', label: '食器洗い乾燥機', aliases: ['食洗機', '食器洗い機'] },
  { value: 'dryer', label: '衣類乾燥機', aliases: ['乾燥機'] },
  { value: 'electric_kettle', label: '電気ケトル', aliases: ['ケトル'] },
  { value: 'fan', label: '扇風機', aliases: ['サーキュレーター'] },
  { value: 'freezer', label: '冷凍庫', aliases: ['冷凍'] },
  { value: 'humidifier', label: '加湿器', aliases: ['加湿'] },
  { value: 'microwave_oven', label: '電子レンジ', aliases: ['オーブンレンジ', 'レンジ'] },
  { value: 'refrigerator', label: '冷蔵庫', aliases: ['冷蔵'] },
  { value: 'rice_cooker', label: '炊飯器', aliases: ['炊飯ジャー'] },
  { value: 'television', label: 'テレビ', aliases: ['TV', '有機EL'] },
  { value: 'vacuum_cleaner', label: '掃除機', aliases: ['クリーナー', 'ロボット掃除機', 'そうじき'] },
  { value: 'washing_machine', label: '洗濯機', aliases: ['ドラム式', '縦型洗濯機', 'せんたくき'] },
  { value: 'other_appliance', label: 'その他の家電', aliases: ['その他'] },
];

export function applianceCategoryLabel(value?: string): string | undefined {
  if (!value) return undefined;
  const option = applianceCategoryOptions.find((item) => item.value === value);
  return option?.label ?? value;
}

/** Read-only display fallback for older manuals that predate the PDF category field. */
export function applianceCategoryFromContent(product: { category?: string; productName?: string; displayName?: string;
  analysis?: { tasks?: readonly { name?: unknown }[] } }): string | undefined {
  const explicit = applianceCategoryOptions.find(option => option.value === product.category || option.label === product.category);
  if (explicit && explicit.value !== 'other_appliance') return explicit.value;
  const name = normalizeCategoryQuery([product.productName, product.displayName].filter(Boolean).join(' '));
  const matches = applianceCategoryOptions.filter(option => option.value !== 'other_appliance').map(option => ({ option,
    score: Math.max(0, ...[option.label, ...option.aliases].map(term => {
      const normalized = normalizeCategoryQuery(term);
      return normalized.length >= 3 && name.includes(normalized) ? normalized.length : 0;
    })) })).filter(match => match.score > 0).sort((a, b) => b.score - a.score);
  if (matches.length && (!matches[1] || matches[0].score > matches[1].score)) return matches[0].option.value;
  // These are appliance-specific part names, not generic tools mentioned in cleaning instructions.
  const titles = Array.isArray(product.analysis?.tasks) ? product.analysis.tasks.map(task => typeof task?.name === 'string' ? task.name : '').join(' ') : '';
  if (/(クリアビン|ブラシバー|クリーナーヘッド)/u.test(titles)) return 'vacuum_cleaner';
  return explicit?.value;
}

export function searchApplianceCategories(query: string): ApplianceCategoryOption[] {
  const normalized = normalizeCategoryQuery(query);
  if (!normalized) return [];

  return applianceCategoryOptions
    .map((option, order) => {
      const terms = [option.label, option.value.replace(/_/gu, ' '), ...option.aliases]
        .map(normalizeCategoryQuery);
      const rank = terms.reduce((best, term) => {
        if (term === normalized) return Math.min(best, 0);
        if (term.startsWith(normalized)) return Math.min(best, 1);
        if (term.includes(normalized)) return Math.min(best, 2);
        return best;
      }, Number.POSITIVE_INFINITY);
      return { option, order, rank };
    })
    .filter((item) => Number.isFinite(item.rank))
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .map((item) => item.option);
}

function normalizeCategoryQuery(value: string): string {
  return value.normalize('NFKC').replace(/[ァ-ヶ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .trim().toLocaleLowerCase('ja-JP').replace(/[\s_・-]+/gu, '');
}
