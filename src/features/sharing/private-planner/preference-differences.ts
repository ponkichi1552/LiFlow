import { minuteLabel } from '../../../domain/calendar/events.ts';
import { formatJapaneseDate } from '../../../domain/scheduling/local-date.ts';
import type { AdaptiveAllowedBand } from '../../planner/adaptive-input';
import type { PrivatePlannerPreferences } from './preferences';

const weekdays = ['月', '火', '水', '木', '金', '土', '日'];
const ranges = (value: readonly AdaptiveAllowedBand[] | undefined, fallback: string) =>
  value === undefined ? fallback : value.map(band => `${minuteLabel(band.startMinute)}〜${minuteLabel(band.endMinute)}`).join('、') || '実施しない';
const budget = (value: number | undefined, fallback = '上限なし') => value === undefined ? fallback : `${value}分`;
const dayType = (holiday: boolean | undefined) => holiday === undefined ? '曜日の設定に従う' : holiday ? '休日' : '平日';

export function privatePreferenceDifferences(local: PrivatePlannerPreferences, remote: PrivatePlannerPreferences) {
  const rows: { label: string; local: string; remote: string }[] = [];
  const add = (label: string, left: string, right: string) => { if (left !== right) rows.push({ label, local: left, remote: right }); };
  const rest = (value: PrivatePlannerPreferences) => value.restDays.map(day => weekdays[day - 1]).join('・') || 'なし';
  const weekly = (value: PrivatePlannerPreferences, day: number) => value.allowedBands.length
    ? ranges(value.allowedBands.filter(band => band.weekday === day), '') : '既定の時間帯';
  add('地域', local.timeZone, remote.timeZone);
  add('休日', rest(local), rest(remote));
  add('重い家事の上限', `${local.loadLimits.heavyDailyLimit}件`, `${remote.loadLimits.heavyDailyLimit}件`);
  add('普通の家事の上限', `${local.loadLimits.normalDailyLimit}件`, `${remote.loadLimits.normalDailyLimit}件`);
  add('1日の家事時間の上限', budget(local.maximumMinutes), budget(remote.maximumMinutes));
  weekdays.forEach((label, index) => add(`${label}曜の時間帯`, weekly(local, index + 1), weekly(remote, index + 1)));
  for (const [type, label] of [['workday', '平日'], ['holiday', '休日']] as const) {
    const left = local.dayTypes?.[type];
    const right = remote.dayTypes?.[type];
    add(`${label}の上限`, budget(left?.maximumMinutes, '1日の設定に従う'), budget(right?.maximumMinutes, '1日の設定に従う'));
    add(`${label}の時間帯`, ranges(left?.allowedBands, '曜日の設定に従う'), ranges(right?.allowedBands, '曜日の設定に従う'));
  }
  const localDates = new Map(local.dayOverrides?.map(item => [item.date, item]));
  const remoteDates = new Map(remote.dayOverrides?.map(item => [item.date, item]));
  for (const date of [...new Set([...localDates.keys(), ...remoteDates.keys()])].sort()) {
    const label = formatJapaneseDate(date, { year: true });
    const left = localDates.get(date);
    const right = remoteDates.get(date);
    add(`${label}の扱い`, dayType(left?.holiday), dayType(right?.holiday));
    add(`${label}の上限`, budget(left?.maximumMinutes, '通常の設定に従う'), budget(right?.maximumMinutes, '通常の設定に従う'));
    add(`${label}の時間帯`, ranges(left?.allowedBands, '通常の設定に従う'), ranges(right?.allowedBands, '通常の設定に従う'));
  }
  return rows;
}
