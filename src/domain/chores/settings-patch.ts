import type { ChoreDefinition, ChoreLoad, LaundryDryingPreference, PersonalChoreSchedule } from './types';
import { resetChoreSchedule } from './schedule-defaults.ts';
import { builtInChoreCatalogEntry } from './catalog.ts';
import { isPersonalConditionBasedAppliance } from './cycle-policy.ts';
import { checkedPersonalSchedule } from './personal-schedule.ts';

/** Only fields edited on the individual settings page. Null explicitly resets a cycle. */
export interface ChoreSettingsPatch {
  resetSchedule?: true;
  enabled?: boolean;
  cycleDays?: number | null;
  windowRadiusDays?: number;
  estimatedMinutes?: number;
  load?: ChoreLoad;
  holidayPriority?: boolean;
  laundryDryingPreference?: LaundryDryingPreference;
  personalSchedule?: PersonalChoreSchedule | null;
  name?: string;
  description?: string;
  instructions?: string[];
  procedureSections?: ChoreDefinition['procedureSections'];
  tools?: string[];
  cautions?: string[];
}

export function parseSettingInteger(text: string, min: number, max: number): number | undefined {
  const normalized = text.normalize('NFKC').trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const number = Number(normalized);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : undefined;
}

/** Apply to the current DB definition, so a delayed save cannot replace unrelated fresh data. */
export function applyChoreSettingsPatch(chore: ChoreDefinition, patch: ChoreSettingsPatch): ChoreDefinition {
  if (chore.personalSchedulingKind === 'seasonal' && (patch.cycleDays != null || patch.windowRadiusDays !== undefined || patch.holidayPriority !== undefined)) throw new Error('季節家事は地域別の固定日を使います。');
  const next = patch.resetSchedule ? resetChoreSchedule(chore) : { ...chore };
  if (patch.personalSchedule !== undefined) {
    if (chore.personalSchedulingKind === 'seasonal') throw new Error('季節家事は地域別の固定日を使います。');
    next.personalSchedule = patch.personalSchedule === null ? undefined : checkedPersonalSchedule(patch.personalSchedule);
    if (next.personalSchedule?.once) next.requiresCycleSelection = false;
  }
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.trim().length > 500) throw new Error('家事名は1〜500文字で入力してください。');
    next.name = patch.name.trim();
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== 'string' || patch.description.length > 20000) throw new Error('説明は20000文字以内で入力してください。');
    next.description = patch.description;
  }
  for (const key of ['instructions', 'tools', 'cautions'] as const) {
    const value = patch[key]; if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > 256 || value.some(text => typeof text !== 'string' || text.length > 5000) || JSON.stringify(value).length > 64000) throw new Error('各項目は256行・64000文字以内で入力してください。');
    next[key] = value.map(text => text.trim()).filter(Boolean);
  }
  if (patch.procedureSections !== undefined) {
    const value = patch.procedureSections;
    if (!Array.isArray(value) || value.length > 64 || JSON.stringify(value).length > 64000
      || value.some(section => !section || typeof section.title !== 'string' || !section.title.trim() || section.title.length > 500
        || !Array.isArray(section.steps) || section.steps.length > 256 || section.steps.some(text => typeof text !== 'string' || text.length > 5000))) throw new Error('手順の見出しと内容を確認してください。');
    next.procedureSections = value.map(section => ({ title: section.title.trim(), steps: section.steps.map(text => text.trim()).filter(Boolean) }));
  }
  if (patch.cycleDays !== undefined) {
    if (patch.cycleDays !== null && (!Number.isSafeInteger(patch.cycleDays) || patch.cycleDays < 1)) {
      throw new RangeError('周期は1日以上の整数で入力してください。');
    }
    const cycle = patch.cycleDays === null ? undefined : patch.cycleDays;
    if (cycle !== undefined && next.personalSchedule?.once) next.personalSchedule = { startDate: next.personalSchedule.startDate };
    next.recommendedCycleDays = cycle;
    // The scheduler prefers userIntervalDays; never leave an older override shadowing a new cycle.
    next.userIntervalDays = chore.applianceId ? cycle : undefined;
    next.requiresCycleSelection = Boolean(cycle === undefined && (builtInChoreCatalogEntry(chore.id)?.requiresCycleSelection
      || chore.applianceCareSource && chore.manufacturerRecommendedIntervalDays === undefined && !isPersonalConditionBasedAppliance(chore)));
    if (next.requiresCycleSelection) next.enabled = false;
  }
  if (patch.windowRadiusDays !== undefined) {
    if (!Number.isInteger(patch.windowRadiusDays) || patch.windowRadiusDays < 0 || patch.windowRadiusDays > 14) throw new RangeError('期間幅は±0〜±14日の整数で入力してください。');
    next.windowRadiusDays = patch.windowRadiusDays;
    if (chore.customPersonal || chore.personalRecipeId || chore.applianceId || chore.applianceCareSource) next.userWindowRadiusDays = patch.windowRadiusDays;
  }
  if (patch.load !== undefined) {
    if (!['light', 'normal', 'heavy'].includes(patch.load)) throw new RangeError('負荷を確認してください。');
    next.load = patch.load;
  }
  if (patch.estimatedMinutes !== undefined) {
    if (!chore.customPersonal || !Number.isSafeInteger(patch.estimatedMinutes) || patch.estimatedMinutes < 1 || patch.estimatedMinutes > 1440) throw new RangeError('目安時間は1〜1440分で入力してください。');
    next.estimatedMinutes = patch.estimatedMinutes;
  }
  if (patch.holidayPriority !== undefined) next.holidayPriority = patch.holidayPriority;
  if (patch.laundryDryingPreference !== undefined) {
    if (!['either', 'outdoors', 'indoors'].includes(patch.laundryDryingPreference)) throw new RangeError('干し方を確認してください。');
    if (chore.category === '洗濯' || chore.laundryDryingPreference !== undefined) next.laundryDryingPreference = patch.laundryDryingPreference;
  }
  if (patch.enabled !== undefined) {
    if (patch.enabled && next.requiresCycleSelection) throw new Error('周期を設定してから有効にしてください。');
    next.enabled = patch.enabled;
  }
  return next;
}
