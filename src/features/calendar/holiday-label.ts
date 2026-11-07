/** Presentation only. Imported titles and Google identities are never rewritten. */
const names: Readonly<Record<string, string>> = {
  "new year's day": '元日', "new years day": '元日', 'coming of age day': '成人の日',
  'national foundation day': '建国記念の日', "emperor's birthday": '天皇誕生日',
  'vernal equinox day': '春分の日', 'showa day': '昭和の日', 'shōwa day': '昭和の日',
  'constitution memorial day': '憲法記念日', 'greenery day': 'みどりの日', "children's day": 'こどもの日',
  'marine day': '海の日', 'mountain day': '山の日', 'respect for the aged day': '敬老の日',
  'autumnal equinox day': '秋分の日', 'sports day': 'スポーツの日', 'health and sports day': 'スポーツの日',
  'culture day': '文化の日', 'labor thanksgiving day': '勤労感謝の日', 'labour thanksgiving day': '勤労感謝の日',
  'substitute holiday': '振替休日', 'bank holiday': '銀行休業日',
  'election day': '選挙の日', 'halloween': 'ハロウィン', 'christmas day': 'クリスマス',
  'christmas eve': 'クリスマスイブ', "new year's eve": '大みそか',
  'thanksgiving day': '感謝祭', 'black friday': 'ブラックフライデー',
  'independence day': '独立記念日', 'veterans day': '退役軍人の日',
  'memorial day': '戦没将兵追悼記念日', 'labor day': '労働者の日', 'labour day': '労働者の日',
  'presidents day': '大統領の日', "presidents' day": '大統領の日',
  'martin luther king jr. day': 'キング牧師記念日', 'juneteenth': '奴隷解放記念日',
  'columbus day': 'コロンブスの日', 'daylight saving time starts': '夏時間開始', 'daylight saving time ends': '夏時間終了',
};

export function japaneseHolidayLabel(title: string): string {
  const value = title.normalize('NFKC').trim();
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value) && !/\p{Script=Latin}/u.test(value)) return value;
  const normalized = value.toLocaleLowerCase('en-US').replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ');
  const observed = normalized.replace(/\s*\(observed\)$/u, '');
  const label = Object.hasOwn(names, observed) ? names[observed] : undefined;
  return label ? normalized === observed ? label : `${label}（振替休日）` : '祝日';
}

export function japaneseHolidayLabels(events: readonly { holiday?: boolean; title: string }[]) {
  return [...new Set(events.filter(event => event.holiday).map(event => japaneseHolidayLabel(event.title)))];
}
