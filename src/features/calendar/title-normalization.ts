type Span = readonly [number, number];
/** Normalize the grammar while keeping every normalized UTF-16 unit tied to its source. */
export function normalizeCalendarTitle(source: string) {
  let text = ''; let spans: Span[] = []; let offset = 0;
  for (const char of source) {
    const normalized = char.normalize('NFKC'); text += normalized;
    for (let i = 0; i < normalized.length; i++) spans.push([offset, offset + char.length]);
    offset += char.length;
  }
  const replace = (pattern: RegExp, value: (match: RegExpMatchArray) => string) => {
    let next = ''; const mapped: Span[] = []; let previous = 0;
    for (const match of text.matchAll(pattern)) {
      const begin = match.index!, end = begin + match[0].length;
      next += text.slice(previous, begin); mapped.push(...spans.slice(previous, begin));
      const replacement = value(match); next += replacement;
      const span: Span = [spans[begin][0], spans[end - 1][1]];
      for (let i = 0; i < replacement.length; i++) mapped.push(span);
      previous = end;
    }
    next += text.slice(previous); mapped.push(...spans.slice(previous)); text = next; spans = mapped;
  };
  const digits: Record<string, number> = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  replace(/[〇零一二三四五六七八九十百千]+/g, ([token]) => {
    if (!/[十百千]/.test(token)) return [...token].map(char => digits[char]).join('');
    // Reject malformed place values instead of silently dropping repeated digits.
    if (!/^(?:[一二三四五六七八九]?千)?(?:[一二三四五六七八九]?百)?(?:[一二三四五六七八九]?十)?[一二三四五六七八九]?$/.test(token)) return '\uE000';
    let total = 0, digit = 0;
    for (const char of token) { if (char in digits) digit = digits[char]; else { total += (digit || 1) * ({ '十': 10, '百': 100, '千': 1000 }[char] ?? 0); digit = 0; } }
    return String(total + digit);
  });
  replace(/https?:\/\/\S+/g, ([url]) => ' '.repeat(url.length));
  replace(/(?<![\d/:.\-])(\d{1,2})\s*([〜~～–-])\s*(?=\d{1,2}(?:時|:\d{2}))/g, match => `${match[1]}時${match[2]}`);
  return { text, sourceSpan(begin: number, end: number): Span { return [spans[begin][0], spans[end - 1][1]]; } };
}
