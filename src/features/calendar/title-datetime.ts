import type { LocalDate } from '../../domain/shared/types';
import type { EventDraft } from './events';
import type { CustomRecurrence } from './recurrence';
import { normalizeCalendarTitle } from './title-normalization.ts';

export interface TitleDateTime { date?: LocalDate; minute?: number; endMinute?: number; endDayOffset?: number; durationDays?: number; allDay?: boolean; recurrence?: 'weekly' | 'monthly' | 'yearly' | 'custom'; customRecurrence?: CustomRecurrence }
const dayMs = 86_400_000;
const iso = (stamp: number) => new Date(stamp).toISOString().slice(0, 10) as LocalDate;
const stamp = (date: LocalDate) => Date.parse(`${date}T00:00:00Z`);
const add = (date: LocalDate, days: number) => iso(stamp(date) + days * dayMs);
const civil = (year: number, month: number, day: number): LocalDate | null => {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day ? iso(value.getTime()) : null;
};
function shiftMonths(date: LocalDate, months: number, explicitDay?: number) {
  const value = new Date(stamp(date)); value.setUTCDate(1); value.setUTCMonth(value.getUTCMonth() + months);
  const year = value.getUTCFullYear(), month = value.getUTCMonth() + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return civil(year, month, explicitDay ?? Math.min(Number(date.slice(-2)), last));
}
function nextMonthDay(today: LocalDate, month: number, day: number) {
  for (let offset = 0; offset <= 8; offset++) {
    const value = civil(Number(today.slice(0, 4)) + offset, month, day);
    if (value && value >= today) return value;
  }
  return null;
}
/** Recognized values prefill an editable draft; incompatible or invalid expressions remain untouched. */
export function parseTitleDateTime(title: string, today: LocalDate, selectedDate: LocalDate, tokens?: (ranges: readonly (readonly [number, number])[]) => void): TitleDateTime | null {
  const normalized = normalizeCalendarTitle(title), text = normalized.text;
  if (/\uE000(?:年|月|日|時|分|週間)/.test(text)) return null;
  // An explicitly written but unsupported year cannot become a yearless date.
  if (/(?:令和|平成|昭和|大正|明治)\s*[^\s年]*年/.test(text)
    || [...text.matchAll(/([\d万億兆]+)\s*年(?=\s*\d{1,2}\s*[月/])/g)].some(match => !/^\d{4}$/.test(match[1]))) return null;
  if (/毎日|隔週|(?:来月|再来月|来年|再来年)(?:の)?(?:初め|頭|上旬|中旬|下旬)/.test(text)) return null;
  const used: [number, number][] = [], dates: LocalDate[] = []; let invalid = false;
  const uncertainTail = /^\s*(?:以外|ではな[いく]|じゃな[いく]|を除|は除|以降|以前|以内|以上|以下|より[前後]|候補|か(?!ら)|または|もしくは|あるいは|の(?:前日|翌日|翌々日|次の日))/;
  const unconsumedDateList = /^\s*(?:[、,・/&＆]|と|および|及び)\s*(?:\d{1,2}日(?!間|目)|\d{1,2}[\/月])/;
  const unhandledDateRange = /^\s*(?:から|[〜~～–-])\s*(?:(?:\d{4}[年/])?\d{1,2}[月/]\d{1,2}|(?:今週|来週|再来週)(?:の)?[月火水木金土日]曜日?|[月火水木金土日]曜日?|明後日|あさって|明日|あした|今日|昨日|\d{1,2}(?:日(?!間|目)|(?=[^\d日週時:]|$)))/;
  const overlaps = (start: number, end: number) => used.some(([a, b]) => start < b && end > a);
  const approximationEnd = (through: number) => through + (/^(?:頃|ごろ|くらい|ぐらい|あたり|付近|前後|程度|ほど)/.exec(text.slice(through))?.[0].length ?? 0);
  const approximationStart = (from: number) => {
    const match = /(?:約|およそ|だいたい|概ね)\s*$/.exec(text.slice(0, from));
    if (!match) return from;
    const start = from - match[0].length, before = text.slice(0, start);
    return !start || /[\s、,：:（(]$/.test(before) || /(?:から|に|は)$/.test(before) || used.some(([, through]) => through === start) ? start : from;
  };
  const collect = (pattern: RegExp, resolve: (match: RegExpMatchArray) => LocalDate | null) => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index!, end = start + match[0].length; if (overlaps(start, end)) continue;
      used.push([start, end]); const date = resolve(match);
      if (!date || uncertainTail.test(text.slice(end)) || unconsumedDateList.test(text.slice(end)) || unhandledDateRange.test(text.slice(end))) invalid = true;
      else dates.push(date);
    }
  };
  const monday = add(today, -((new Date(stamp(today)).getUTCDay() + 6) % 7));
  const weekday = (char: string) => '月火水木金土日'.indexOf(char);
  const weekdaySuffix = '(?:曜日?|(?=\\s|\\d|に|から|$))';
  const separator = '(?:[、,・/&＆]|と|および|及び)';
  const weekDayToken = `[月火水木金土日](?:曜日?|(?=\\s|\\d|に|から|$|${separator}))`;
  const monthDayToken = `\\d{1,2}(?:日(?!間|以内|前(?!後)|後)|(?=\\s*${separator}))`;
  const repeats = [...text.matchAll(new RegExp(`毎週\\s*(?:の\\s*)?(${weekDayToken}(?:\\s*${separator}\\s*(?:毎週\\s*(?:の\\s*)?)?${weekDayToken})*)|毎月\\s*(?:の\\s*)?(${monthDayToken}(?:\\s*${separator}\\s*(?:毎月\\s*(?:の\\s*)?)?${monthDayToken})*)|毎年\\s*(?:の\\s*)?(\\d{1,2}月\\d{1,2}日)`, 'g'))];
  if (repeats.length > 1) return null;
  const repeat = repeats[0];
  const repeatUnit = repeat ? repeat[1] ? 'week' : repeat[2] ? 'month' : 'year' : undefined;
  const repeatDays = repeat && repeatUnit !== 'year' ? [...new Set(repeat[1] ? [...repeat[1].matchAll(new RegExp(weekDayToken, 'g'))].map(match => (weekday(match[0][0]) + 1) % 7)
    : [...repeat[2].matchAll(/\d+/g)].map(match => Number(match[0])))].sort((a, b) => a - b) : [];
  let customRecurrence: CustomRecurrence | undefined = repeatDays.length > 1
    ? repeatUnit === 'week' ? { unit: 'week', interval: 1, weekdays: repeatDays } : { unit: 'month', interval: 1, on: 'dates', days: repeatDays } : undefined;
  const recurrence = repeat ? customRecurrence ? 'custom' : repeatUnit === 'week' ? 'weekly' : repeatUnit === 'month' ? 'monthly' : 'yearly' : undefined;
  const maskUsed = () => text.split('').map((char, index) => overlaps(index, index + 1) ? ' ' : char).join('');
  if (repeat) {
    used.push([repeat.index!, repeat.index! + repeat[0].length]);
    const tail = text.slice(repeat.index! + repeat[0].length);
    if (uncertainTail.test(tail) || unconsumedDateList.test(tail) || unhandledDateRange.test(tail)
      || new RegExp(`^\\s*${separator}\\s*$`).test(tail)) return null;
  }
  if (/毎週|毎月|毎年/.test(maskUsed())) return null;
  collect(new RegExp(`(今週|来週|再来週)(?:の)?([月火水木金土日])${weekdaySuffix}`, 'g'), m => add(monday, ({ 今週: 0, 来週: 7, 再来週: 14 }[m[1]] ?? 0) + weekday(m[2])));
  collect(new RegExp(`(\\d+)週間後(?:の)?([月火水木金土日])${weekdaySuffix}`, 'g'), m => Number(m[1]) <= 5200 ? add(monday, Number(m[1]) * 7 + weekday(m[2])) : null);
  collect(/(今年|来年|再来年)(?:の)?(?:年末|末)/g, m => civil(Number(today.slice(0, 4)) + ({ 今年: 0, 来年: 1, 再来年: 2 }[m[1]] ?? 0), 12, 31));
  collect(/(今年|来年|再来年)(?:の)?(\d{1,2})月(\d{1,2})日/g, m => civil(Number(today.slice(0, 4)) + ({ 今年: 0, 来年: 1, 再来年: 2 }[m[1]] ?? 0), Number(m[2]), Number(m[3])));
  collect(/(今月|来月|再来月)(?:の)?末(?:日)?/g, m => { const shifted = shiftMonths(today, ({ 今月: 0, 来月: 1, 再来月: 2 }[m[1]] ?? 0)); return shifted ? iso(Date.UTC(Number(shifted.slice(0, 4)), Number(shifted.slice(5, 7)), 0)) : null; });
  collect(/(?<!\d)(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, m => m[1] ? civil(Number(m[1]), Number(m[2]), Number(m[3])) : nextMonthDay(today, Number(m[2]), Number(m[3])));
  collect(/(?<![\d/.])(?:(\d{4})\s*(?:\/|年)\s*)?(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/g, m => m[1] ? civil(Number(m[1]), Number(m[2]), Number(m[3])) : nextMonthDay(today, Number(m[2]), Number(m[3])));
  collect(/(来月|再来月)(?:の)?(?:(\d{1,2})日)?/g, m => shiftMonths(today, m[1] === '来月' ? 1 : 2, m[2] === undefined ? undefined : Number(m[2])));
  collect(/来年|再来年/g, m => shiftMonths(today, m[0] === '来年' ? 12 : 24));
  collect(/(?<!\d)(\d+)(日|週間|週|か月|ヶ月|ケ月|月|年)後/g, m => {
    const n = Number(m[1]); if (!Number.isSafeInteger(n) || n > 36500) return null;
    if (m[2] === '日') return add(today, n);
    if (m[2] === '週間' || m[2] === '週') return n <= 5200 ? add(today, n * 7) : null;
    return shiftMonths(today, n * (m[2] === '年' ? 12 : 1));
  });
  collect(/明後日|あさって|今日|明日|あした|あす|昨日|今週|来週|再来週/g, m => add(today, ({ 明後日: 2, あさって: 2, 今日: 0, 明日: 1, あした: 1, あす: 1, 昨日: -1, 今週: 0, 来週: 7, 再来週: 14 }[m[0]] ?? 0)));
  collect(/(次の)?([月火水木金土日])曜日?/g, m => {
    const delta = (weekday(m[2]) - ((new Date(stamp(today)).getUTCDay() + 6) % 7) + 7) % 7;
    return add(today, delta || (m[1] ? 7 : 0));
  });
  if (invalid || new Set(dates).size > 1 || /(?:\d+時(?:半|\d+分)?)(?:間|台|前(?!後)|以降|より前)/.test(text)) return null;
  if (repeat) {
    if (repeatUnit === 'month' && (repeatDays.some(day => day < 1 || day > 31) || /\d+日/.test(maskUsed()))) return null;
    if (repeatUnit === 'year') {
      const [month, day] = repeat[3].match(/\d+/g)!.map(Number);
      if (dates.length) { if (Number(dates[0].slice(5, 7)) !== month || Number(dates[0].slice(-2)) !== day) return null; }
      else { const first = nextMonthDay(today, month, day); if (!first) return null; dates.push(first); }
    } else if (dates.length) {
      if (!repeatDays.includes(repeatUnit === 'week' ? new Date(stamp(dates[0])).getUTCDay() : Number(dates[0].slice(-2)))) return null;
    } else if (repeatUnit === 'week') {
      const first = add(today, Math.min(...repeatDays.map(day => (day - new Date(stamp(today)).getUTCDay() + 7) % 7)));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) return null;
      dates.push(first);
    } else {
      let first: LocalDate | null = null;
      for (let offset = 0; offset <= 12 && !first; offset++) {
        for (const day of repeatDays) { const next = shiftMonths(today, offset, day); if (next && next >= today && (!first || next < first)) first = next; }
      }
      if (!first) return null;
      dates.push(first);
    }
  }
  const clocks: { minute: number; nextDay: boolean; from: number; through: number }[] = [];
  const pattern = /(?<!\d)(?:(午前|午後|朝|昼|夕方|夜|深夜)\s*)?(\d{1,2})(?::(\d{2})|時(?:(\d{1,2})分|(\d{2})(?!分)|半)?)(?!\d|間|台)/g;
  for (const m of text.matchAll(pattern)) {
    const minutes = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? Number(m[4]) : m[5] !== undefined ? Number(m[5]) : m[0].endsWith('半') ? 30 : 0;
    let hour = Number(m[2]);
    if (minutes > 59 || hour > 24 || hour === 24 && (minutes !== 0 || m[1])) return null;
    if (m[1]) {
      if (hour > 12) return null;
      if (m[1] === '午前' || m[1] === '深夜') hour %= 12;
      else if (m[1] === '午後' || m[1] === '夕方' || m[1] === '夜') hour = hour % 12 + (m[1] === '夜' && (hour === 0 || hour === 12) ? 0 : 12);
      else if (m[1] === '昼' && hour < 11) hour = hour % 12 + 12;
      else if (m[1] === '朝' && hour === 12) return null;
    }
    clocks.push({ minute: hour % 24 * 60 + minutes, nextDay: hour === 24, from: approximationStart(m.index!), through: approximationEnd(m.index! + m[0].length) });
  }
  if (clocks.length === 1 && /\d+\s*(?:から|[〜~～–-])\s*$/.test(text.slice(0, clocks[0].from))) return null;
  if (clocks.length > 2 || clocks.length === 2 && !/^(?:から|[〜~～–-])$/.test(text.slice(clocks[0].through, clocks[1].from).trim())) return null;
  const allDay = /終日/.test(text); if (allDay && clocks.length) return null;
  const durations = [...text.matchAll(/(?<![\d.])(\d+)(日間|週間)(?!後|前(?!後)|以内|以上|以下|半)/g)];
  const mentionedDurations = [...text.matchAll(/(?<![\d.])[-+]?\d+(?:\.\d+)?(?:日間|週間)(?!後|前(?!後))/g)];
  if (durations.length > 1 || mentionedDurations.length !== durations.length || /\d+\.\d+(?:日間|週間)/.test(text)) return null;
  const duration = durations[0], durationDays = duration ? Number(duration[1]) * (duration[2] === '週間' ? 7 : 1) : undefined;
  if (duration && (!dates.length || durationDays! < 1 || durationDays! > 366 || clocks.length > 1
    || /[-+]\s*$/.test(text.slice(0, duration.index!))
    || /^\s*(?:以内|以上|以下|半|か(?!ら)|または|もしくは)/.test(text.slice(duration.index! + duration[0].length))
    || !used.some(([from, through]) => through <= duration.index! && /から/.test(text.slice(through, duration.index!))))) return null;
  // Month/year 24:00 anchors can change a short-month or leap-year skip rule.
  if ((repeatUnit === 'month' || repeatUnit === 'year') && clocks[0]?.nextDay) return null;
  if (customRecurrence?.unit === 'week' && clocks[0]?.nextDay) customRecurrence = { ...customRecurrence, weekdays: customRecurrence.weekdays.map(day => (day + 1) % 7).sort((a, b) => a - b) };
  if (!dates.length && !clocks.length && !allDay) return null;
  const result: TitleDateTime = { ...(dates.length ? { date: dates[0] } : {}), ...(allDay ? { allDay: true } : {}), ...(recurrence ? { recurrence } : {}), ...(customRecurrence ? { customRecurrence } : {}) };
  if (durationDays !== undefined) { result.durationDays = durationDays; result.allDay = clocks.length === 0; }
  if (clocks.length) {
    result.minute = clocks[0].minute; result.allDay = false;
    if (clocks[0].nextDay) result.date = add(result.date ?? selectedDate, 1);
    if (clocks.length === 2) {
      if (clocks[0].minute === clocks[1].minute && !clocks[1].nextDay) return null;
      result.endMinute = clocks[1].minute;
      result.endDayOffset = clocks[1].nextDay || clocks[1].minute < clocks[0].minute ? 1 : 0;
    }
  }
  if (tokens) {
    const ranges = [...used, ...clocks.map(clock => [clock.from, clock.through] as [number, number]),
      ...[...text.matchAll(/終日/g)].map(match => [match.index!, match.index! + match[0].length] as [number, number]),
      ...(duration ? [[duration.index!, duration.index! + duration[0].length] as [number, number]] : [])];
    if (clocks.length === 2) ranges.push([clocks[0].from, clocks[1].through]);
    tokens(ranges.map(([from, through]) => {
      from = approximationStart(from); through = approximationEnd(through);
      const suffix = /^(?:から|に|は|の)(?=[一-龯々ァ-ヶA-Za-z0-9]|\s|$)/.exec(text.slice(through));
      return normalized.sourceSpan(from, through + (suffix?.[0].length ?? 0));
    }));
  }
  return result;
}

/** Presentation/export only; the stored title and unrelated name characters remain untouched. */
export function calendarTitleLabel(title: string, referenceDate: LocalDate, shorten = true): string {
  if (!shorten) return title;
  let ranges: readonly (readonly [number, number])[] = [];
  const parsed = parseTitleDateTime(title, referenceDate, referenceDate, value => { ranges = value; });
  if (!parsed) return title;
  const label = title.split('').filter((_, index) => !ranges.some(([from, through]) => index >= from && index < through)).join('')
    .replace(/^[\s、,，・:：]+|[\s、,，・:：]+$/g, '');
  return label || title;
}

type InferredField = 'startDate' | 'endDate' | 'startMinute' | 'endMinute' | 'allDay' | 'recurrence';
/** Keep the title verbatim, restore removed automatic fields, and honor manual fields. */
export function createTitleDateTimeInput(initial: EventDraft, today: LocalDate) {
  const locked = new Set<InferredField>(initial.recurrence !== 'none' ? ['recurrence'] : []); let applied = false;
  const duration = Math.max(1, (stamp(initial.endDate) - stamp(initial.startDate)) / 60000 + initial.endMinute - initial.startMinute);
  return {
    manual(field: InferredField) { locked.add(field); },
    change(current: EventDraft, title: string, enabled: boolean): EventDraft {
      if (!enabled) return { ...current, title };
      const parsed = parseTitleDateTime(title, today, locked.has('startDate') ? current.startDate : initial.startDate);
      if (!parsed && !applied) return { ...current, title };
      applied = Boolean(parsed);
      const startDate = locked.has('startDate') ? current.startDate : parsed?.date ?? initial.startDate;
      const startMinute = locked.has('startMinute') ? current.startMinute : parsed?.minute ?? initial.startMinute;
      const end = stamp(startDate) + startMinute * 60000 + duration * 60000;
      const allDay = locked.has('allDay') ? current.allDay : parsed?.allDay ?? initial.allDay;
      const next = { ...current, title, startDate, startMinute,
        endDate: locked.has('endDate') ? current.endDate : parsed?.durationDays !== undefined ? add(startDate, parsed.durationDays - (allDay ? 1 : 0)) : parsed?.endMinute !== undefined ? add(startDate, parsed.endDayOffset ?? 0) : iso(end),
        endMinute: locked.has('endMinute') ? current.endMinute : parsed?.durationDays !== undefined && !allDay ? startMinute : parsed?.endMinute ?? new Date(end).getUTCHours() * 60 + new Date(end).getUTCMinutes(),
        allDay,
        recurrence: locked.has('recurrence') ? current.recurrence : parsed?.recurrence ?? initial.recurrence,
        untilDate: locked.has('recurrence') || parsed?.recurrence ? current.untilDate : initial.untilDate };
      if (!locked.has('recurrence')) {
        if (parsed?.customRecurrence) next.customRecurrence = parsed.customRecurrence;
        else if (initial.customRecurrence) next.customRecurrence = initial.customRecurrence;
        else delete next.customRecurrence;
      }
      return next;
    },
  };
}
