import type { ChoreDefinition } from './types';
import { parseSettingInteger } from './settings-patch.ts';

export function customChoreInput(name: string, interval: string | number) {
  const value = name.trim();
  if (!value || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('家事名を1〜500文字で入力してください。');
  const days = parseSettingInteger(String(interval), 1, 3650);
  if (days === undefined) throw new Error('周期を1〜3650日の整数で入力してください。');
  return { name: value, intervalDays: days };
}
export interface CustomChoreOptions { windowRadiusDays?: number; windowBeforeDays?: number; windowAfterDays?: number; load?: ChoreDefinition['load']; holidayPriority?: boolean; estimatedMinutes?: number; instructions?: string[] }
export function customChoreOptions(input: CustomChoreOptions = {}) {
  const integer = (value: number | undefined, fallback: number, max: number, label: string) => {
    const number = value ?? fallback; if (!Number.isSafeInteger(number) || number < (label === '目安時間' ? 1 : 0) || number > max) throw new Error(`${label}を確認してください。`); return number;
  };
  if (input.load !== undefined && !['light', 'normal', 'heavy'].includes(input.load) || input.holidayPriority !== undefined && typeof input.holidayPriority !== 'boolean') throw new Error('家事の設定を確認してください。');
  if (input.instructions !== undefined && (!Array.isArray(input.instructions) || input.instructions.length > 1000 || input.instructions.some(step => typeof step !== 'string' || step.length > 20000))) throw new Error('手順を確認してください。');
  return { windowRadiusDays: integer(input.windowRadiusDays, 0, 14, '実施期間の幅'), windowBeforeDays: integer(input.windowBeforeDays, 0, 14, '実施期間の幅'), windowAfterDays: integer(input.windowAfterDays, 0, 14, '実施期間の幅'),
    load: input.load ?? 'normal', holidayPriority: input.holidayPriority ?? false, estimatedMinutes: integer(input.estimatedMinutes, 15, 1440, '目安時間'), instructions: input.instructions?.map(step => step.trim()).filter(Boolean) ?? [] };
}
export function createCustomPersonalChore(id: string, householdId: string, name: string, interval: number, options?: CustomChoreOptions): ChoreDefinition {
  if (!/^custom-chore-[A-Za-z0-9.-]{1,120}$/u.test(id)) throw new Error('追加する家事の保存先を確認してください。');
  const value = customChoreInput(name, interval);
  const selected = customChoreOptions(options);
  const frequencyDaysByMode = { frequent: value.intervalDays, balanced: value.intervalDays, relaxed: value.intervalDays };
  return { id, householdId, name: value.name, category: '追加した家事', description: '', enabled: true,
    customPersonal: true, personalSchedulingKind: 'personal', frequencyDaysByMode,
    windowRadiusDays: selected.windowRadiusDays, userWindowRadiusDays: selected.windowRadiusDays, maxShiftDays: 0, load: selected.load, holidayPriority: selected.holidayPriority,
    everyday: value.intervalDays === 1, estimatedMinutes: selected.estimatedMinutes, instructions: selected.instructions, tools: [], cautions: [],
    personalScheduleDefaults: { frequencyDaysByMode: { ...frequencyDaysByMode }, windowRadiusDays: 0, maxShiftDays: 0,
      load: 'normal', holidayPriority: false, everyday: value.intervalDays === 1, requiresCycleSelection: false } };
}
