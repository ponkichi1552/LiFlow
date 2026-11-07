import { normalizeWasteTypeText, wasteTypeIndex, WASTE_TYPES } from './waste-types.ts';

// Stable by waste name, never by schedule id, recurrence, weekday, or list order.
// Dark colors keep names readable on the calendar's white background.
const typeColors: Readonly<Record<string, string>> = {
  '可燃ごみ': '#B85B13', '不燃ごみ': '#53617D', '資源ごみ': '#217B42', 'びん': '#08787C',
  '缶': '#265DB4', 'びん・缶': '#4F46A5', 'ペットボトル': '#087AA2', 'プラスチック資源': '#8953A0',
  '容器包装プラスチック': '#A04476', '製品プラスチック': '#5C50B6', '古紙': '#53752B', '新聞': '#27654E',
  '雑誌': '#85552E', '段ボール': '#916827', '紙パック': '#427F71', '雑がみ': '#666D36',
  '古布・衣類': '#9C4560', '小型家電': '#536CB0', '乾電池': '#957016', '充電池': '#A33C49',
  '蛍光灯': '#777024', '有害ごみ': '#984B2D', '危険ごみ': '#A83E32', 'スプレー缶': '#94536B',
  '金属類': '#4E6985', '粗大ごみ': '#744A91', '剪定枝': '#3E7942', '落ち葉・草': '#777934',
  '生ごみ': '#A45C3B', '陶磁器・ガラス': '#487785', '発泡スチロール': '#64739C', '使用済み食用油': '#857127',
};

const knownTypeIndex = wasteTypeIndex;

export function canonicalWasteType(label: string): string {
  const index = knownTypeIndex(label);
  return index < 0 ? label : WASTE_TYPES[index].label;
}

export type WasteIconKind = 'bottle' | 'petBottle' | 'can' | 'bottleCan' | 'fire' | 'paper' | 'box' | 'recycle' | 'battery' | 'appliance' | 'bulky' | 'plant' | 'food' | 'hazard' | 'oil' | 'trash';
export function wasteTypeIcon(label: string): WasteIconKind {
  const name = canonicalWasteType(label);
  if (name === 'びん') return 'bottle';
  if (name === 'ペットボトル') return 'petBottle';
  if (name === '缶' || name === 'スプレー缶') return 'can';
  if (name === 'びん・缶') return 'bottleCan';
  if (name === '可燃ごみ') return 'fire';
  if (['古紙', '新聞', '雑誌', '紙パック', '雑がみ'].includes(name)) return 'paper';
  if (name === '段ボール') return 'box';
  if (['資源ごみ', 'プラスチック資源', '容器包装プラスチック', '製品プラスチック'].includes(name)) return 'recycle';
  if (name === '乾電池' || name === '充電池') return 'battery';
  if (name === '小型家電') return 'appliance';
  if (name === '粗大ごみ') return 'bulky';
  if (name === '剪定枝' || name === '落ち葉・草') return 'plant';
  if (name === '生ごみ') return 'food';
  if (['有害ごみ', '危険ごみ', '蛍光灯'].includes(name)) return 'hazard';
  if (name === '使用済み食用油') return 'oil';
  return 'trash';
}

export function wasteTypeColor(label: string, appearance: 'light' | 'dark' = 'light'): string {
  const index = knownTypeIndex(label);
  if (index >= 0) {
    const color = typeColors[WASTE_TYPES[index].label];
    if (appearance === 'light') return color;
    return '#' + color.slice(1).match(/../gu)!.map(value => Math.round(parseInt(value, 16) * 0.55 + 255 * 0.45).toString(16).padStart(2, '0')).join('');
  }
  const hash = [...normalizeWasteTypeText(label)].reduce((value, char) => (value * 31 + char.codePointAt(0)!) >>> 0, 0);
  return `hsl(${hash % 360}, 58%, ${appearance === 'dark' ? '72%' : '32%'})`;
}

/** Compact names fit two readable lines in a seven-column mobile calendar. */
export function calendarWasteLabel(label: string): string {
  const index = knownTypeIndex(label);
  const canonical = index >= 0 ? WASTE_TYPES[index].label : label;
  const compact: Record<string, string> = {
    'プラスチック資源': 'プラ資源', '容器包装プラスチック': '容器プラ', '製品プラスチック': '製品プラ',
    '陶磁器・ガラス': '陶器・ガラス', '発泡スチロール': '発泡材', '使用済み食用油': '食用油',
  };
  // Only calendar captions are shortened. Stored names, settings and colors remain canonical.
  return (Object.hasOwn(compact, canonical) ? compact[canonical] : canonical).replace(/[ごゴ][みミ]/gu, '').trim();
}
