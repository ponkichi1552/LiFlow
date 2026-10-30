import type { LocalDate } from '../../../domain/shared/types';
import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { ScheduleSettings } from '../../../domain/scheduling/contracts';
import { sharedLocalDate } from '../group-clock.ts';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { buildV2PersonalPlan } from '../v2/personal-plan.ts';
import type { V2PersonalPlan } from '../v2/personal-plan';
import { v2CalendarMonth } from './calendar-projection.ts';
import type { V2PrivateOverlayState, V2PrivateTaskSource } from './private-overlay';
import type { PrivateCalendarRuntime } from '../private-calendar/runtime';
import { assessV2UntimedDailyLoad } from '../v2/daily-load.ts';
import type { V2DailyLoadAssessment } from '../v2/daily-load';
import { v2CommonCompletionSource } from './common-chore-history.ts';
import { combineCalendarConflicts } from '../v2/private-availability.ts';
import type { PrivateCalendarAvailability } from '../v2/private-availability.ts';

export interface V2GroupUiSession {
  controller: V2GroupController; groupId: string; userId: string;
  privateTasks?: V2PrivateTaskSource;
  readOwnCalendar?: PrivateCalendarRuntime['readOwnCalendar'];
  readModel: (options?: { calendarMonth?: string; focusDate?: string; detailChoreId?: string; management?: boolean; groupPolicy?: boolean; permissionsChoreId?: string; waste?: boolean; appliances?: boolean; applianceId?: string; reminders?: boolean }) => Promise<V2GroupScreenModel & { personal?: V2PersonalPlan; privateOverlay?: V2PrivateOverlayState; dailyLoad?: V2DailyLoadAssessment }>;
}

/** The UI computes its range and personal suggestions from one authenticated group clock. */
export function createV2ScreenSession(input: { controller: V2GroupController; groupId: string; userId: string; now: () => Date;
  readPreferences: () => { ownerUserId: string; settings: ScheduleSettings } | Promise<{ ownerUserId: string; settings: ScheduleSettings }>;
  privateTasks?: V2PrivateTaskSource;
  calendar?: Pick<PrivateCalendarRuntime, 'readForPlan' | 'readOwnCalendar'>;
  localCalendar?: {
    readForPlan: (range: { from: LocalDate; through: LocalDate }, timeZone: string) => Promise<{ ownerUserId: string; availability: PrivateCalendarAvailability }>;
    readOwnCalendar: (target: Parameters<PrivateCalendarRuntime['readOwnCalendar']>[0], timeZone?: string) => ReturnType<PrivateCalendarRuntime['readOwnCalendar']>;
  };
}): V2GroupUiSession {
  let planTimeZone: string | undefined;
  return { controller: input.controller, groupId: input.groupId, userId: input.userId, privateTasks: input.privateTasks,
    readOwnCalendar: input.localCalendar ? async target => {
      const local = await input.localCalendar!.readOwnCalendar(target, planTimeZone);
      return input.calendar ? combineCalendarConflicts(local, await input.calendar.readOwnCalendar(target)) : local;
    } : input.calendar?.readOwnCalendar,
    async readModel(options) {
      if (options?.reminders && (options.management || options.calendarMonth || options.focusDate)) throw new Error('通知用と画面用の予定範囲を同時に指定できません。');
      if (options?.calendarMonth && options.focusDate) throw new Error('月表示と家事回の表示を同時に指定できません。');
      if (options?.management && (options.calendarMonth || options.focusDate)) throw new Error('編集画面と月・家事回の表示を同時に指定できません。');
      const instant = input.now(); const preferences = options?.management ? null : await input.readPreferences();
      if (preferences && preferences.ownerUserId !== input.userId) throw new Error('本人の予定設定を確認してください。');
      const model = await input.controller.readModel(({ timeZone }) => {
        const date = sharedLocalDate(instant, timeZone); const focus = options?.focusDate as LocalDate | undefined;
        if (options?.reminders) return { from: addDays(date, -5), through: addDays(date, 30), asOfDate: date };
        if (options?.management) return { from: date, through: date, asOfDate: date };
        if (focus) parseLocalDate(focus);
        const calendar = options?.calendarMonth ? v2CalendarMonth(options.calendarMonth === 'current' ? date : options.calendarMonth as LocalDate) : null;
        return { from: addDays(calendar?.from ?? focus ?? date, -14), through: addDays(calendar?.through ?? focus ?? date, 14), asOfDate: date };
      }, { detailChoreId: options?.detailChoreId, groupPolicy: options?.groupPolicy, permissionsChoreId: options?.permissionsChoreId, waste: options?.waste, appliances: options?.appliances, applianceId: options?.applianceId });
      if (model.viewerUserId !== input.userId || model.plan.groupId !== input.groupId) throw new Error('表示する共有アカウント・グループが変わりました。');
      planTimeZone = model.plan.timeZone;
      if (!preferences) return model;
      // Local ciphertext only: rendering cannot request OAuth, fetch Google or publish private data.
      let calendar: Awaited<ReturnType<PrivateCalendarRuntime['readForPlan']>> = null;
      if (input.calendar) try { calendar = await input.calendar.readForPlan(); } catch { /* An unavailable private cache stays unconfirmed. */ }
      if (calendar && (calendar.ownerUserId !== input.userId || calendar.binding.ownerUserId !== input.userId || calendar.cache.ownerUserId !== input.userId)) throw new Error('本人のCalendar情報を確認してください。');
      let localCalendar: { ownerUserId: string; availability: PrivateCalendarAvailability } | undefined;
      if (input.localCalendar) try { localCalendar = await input.localCalendar.readForPlan(model.plan.range, model.plan.timeZone); }
      catch { localCalendar = { ownerUserId: input.userId, availability: () => ({ conflict: { kind: 'unknown', reason: 'invalid' }, busyMinutes: null }) }; }
      if (localCalendar && localCalendar.ownerUserId !== input.userId) throw new Error('本人のCalendar情報を確認してください。');
      let privateOverlay: V2PrivateOverlayState | undefined;
      if (input.privateTasks && !options?.management) try {
        await input.privateTasks.mirrorShared?.(v2CommonCompletionSource(model));
        privateOverlay = await input.privateTasks.read(model.plan.range, instant, model.plan.chores);
        if (privateOverlay.ownerUserId !== input.userId) throw new Error('本人の個人家事を確認してください。');
      } catch { privateOverlay = { status: 'unavailable', message: '個人家事を取得できませんでした。個人モードの状態を確認し、再読込してください。' }; }
      const privateLoad = privateOverlay?.status === 'ready' && privateOverlay.timeZone === model.plan.timeZone
        ? { ownerUserId: input.userId, days: privateOverlay.dailyLoad } : undefined;
      const personal = buildV2PersonalPlan(model.plan, { viewerUserId: input.userId, now: instant.getTime(), settings: preferences.settings, privateLoad, localCalendar,
        ...(calendar ? { calendar: { cache: calendar.cache, binding: calendar.binding } } : {}) });
      const dailyLoad = model.plan.initialized && model.plan.policy && model.plan.range.from <= model.plan.range.asOfDate && model.plan.range.through >= model.plan.range.asOfDate
        ? assessV2UntimedDailyLoad({ model, userId: input.userId, personal, privateOverlay, limits: preferences.settings.loadLimits }) : undefined;
      return { ...model, personal, ...(privateOverlay ? { privateOverlay } : {}), ...(dailyLoad ? { dailyLoad } : {}) };
    } };
}
