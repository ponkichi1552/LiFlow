import type { LocalDate } from '../../../domain/shared/types';
import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { ScheduleSettings } from '../../../domain/scheduling/contracts';
import { sharedLocalDate } from '../group-clock.ts';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { buildV2PersonalPlan } from '../v2/personal-plan.ts';
import type { V2PersonalPlan } from '../v2/personal-plan';
import { v2CalendarMonth } from './calendar-projection.ts';
import { v2CalendarDisplayRange } from './calendar-range.ts';
import type { V2PrivateOverlayState, V2PrivateTaskSource } from './private-overlay';
import type { PrivateCalendarRuntime } from '../private-calendar/runtime';
import { v2CommonCompletionSource } from './common-chore-history.ts';
import { combineCalendarConflicts, combinePrivateCalendarAvailability } from '../v2/private-availability.ts';
import type { PrivateCalendarAvailability } from '../v2/private-availability.ts';
import { sharedCalendarAvailability } from '../../calendar/shared-events.ts';
import { localCalendarTargetRange } from '../../calendar/private-availability.ts';
import type { SharedCalendarRecord } from '../v2/calendar-state';
import { traceStartup } from '../../../platform/diagnostics/startup-timing.ts';

export interface V2GroupUiSession {
  controller: V2GroupController; groupId: string; userId: string;
  privateTasks?: V2PrivateTaskSource;
  readOwnCalendar?: PrivateCalendarRuntime['readOwnCalendar'];
  invalidate?: () => void;
  readModel: (options?: { calendarMonth?: string; calendarRange?: { from: LocalDate; through: LocalDate }; focusDate?: string; detailChoreId?: string; choreSettings?: boolean; management?: boolean; groupPolicy?: boolean; permissionsChoreId?: string; waste?: boolean; appliances?: boolean; applianceId?: string; reminders?: boolean }) => Promise<V2GroupScreenModel & { personal?: V2PersonalPlan; privateOverlay?: V2PrivateOverlayState }>;
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
  let calendarRecords: readonly SharedCalendarRecord[] = [];
  return { controller: input.controller, groupId: input.groupId, userId: input.userId, privateTasks: input.privateTasks,
    readOwnCalendar: async target => {
      if (target.precision !== 'interval') return { kind: 'unknown', reason: 'timeNotSpecified' };
      const current = await input.controller.readCalendar?.();
      if (current && (current.groupId !== input.groupId || current.viewerUserId !== input.userId)) throw new Error('表示する共有アカウント・グループが変わりました。');
      const zone = current?.timeZone ?? planTimeZone;
      if (!zone) throw new Error('共有予定の地域を読み直してください。');
      const range = localCalendarTargetRange(target, zone)!;
      const shared = sharedCalendarAvailability(current?.records ?? calendarRecords, input.groupId, range, zone);
      let result = shared?.(target).conflict;
      for (const read of [input.localCalendar ? () => input.localCalendar!.readOwnCalendar(target, zone) : undefined,
        input.calendar ? () => input.calendar!.readOwnCalendar(target) : undefined]) if (read) {
        const next = await read(); result = result ? combineCalendarConflicts(result, next) : next;
      }
      return result ?? { kind: 'unknown', reason: 'missing' };
    },
    async readModel(options) {
      if (options?.choreSettings && !options.management) throw new Error('連続した家事設定は編集画面から読み込んでください。');
      if (options?.reminders && (options.management || options.calendarMonth || options.focusDate)) throw new Error('通知用と画面用の予定範囲を同時に指定できません。');
      if (options?.calendarMonth && options.focusDate) throw new Error('月表示と家事回の表示を同時に指定できません。');
      if (options?.management && (options.calendarMonth || options.focusDate)) throw new Error('編集画面と月・家事回の表示を同時に指定できません。');
      if (options?.calendarRange) {
        const { from, through } = options.calendarRange; parseLocalDate(from); parseLocalDate(through);
        if (!options.calendarMonth || from > through || through > addDays(from, 366)) throw new Error('表示するカレンダーの期間を確認してください。');
      }
      const instant = input.now(); const preferences = options?.management ? null : await traceStartup('display.preferences', input.readPreferences);
      if (preferences && preferences.ownerUserId !== input.userId) throw new Error('本人の予定設定を確認してください。');
      const model = await traceStartup('display.sharedPlan', () => input.controller.readModel(({ timeZone }) => {
        const date = sharedLocalDate(instant, timeZone); const focus = options?.focusDate as LocalDate | undefined;
        if (options?.reminders) return { from: addDays(date, -5), through: addDays(date, 30), asOfDate: date };
        if (options?.management) return { from: date, through: date, asOfDate: date };
        if (focus) parseLocalDate(focus);
        const calendar = options?.calendarMonth ? v2CalendarMonth(options.calendarMonth === 'current' ? date : options.calendarMonth as LocalDate) : null;
        if (calendar) {
          const range = options?.calendarRange ?? v2CalendarDisplayRange(calendar.month);
          if (range.from > calendar.from || range.through < calendar.through) throw new Error('表示する月が取得期間に含まれていません。');
          return { ...range, asOfDate: date };
        }
        return { from: addDays(focus ?? date, -14), through: addDays(focus ?? date, 14), asOfDate: date };
      }, { detailChoreId: options?.detailChoreId, choreSettings: options?.choreSettings, groupPolicy: options?.groupPolicy, permissionsChoreId: options?.permissionsChoreId, waste: options?.waste, appliances: options?.appliances, applianceId: options?.applianceId }));
      if (model.viewerUserId !== input.userId || model.plan.groupId !== input.groupId) throw new Error('表示する共有アカウント・グループが変わりました。');
      planTimeZone = model.plan.timeZone;
      calendarRecords = model.calendar ?? [];
      if (!preferences) return model;
      // Local ciphertext only: rendering cannot request OAuth, fetch Google or publish private data.
      let calendar: Awaited<ReturnType<PrivateCalendarRuntime['readForPlan']>> = null;
      if (input.calendar) try { calendar = await traceStartup('display.privateCalendar', () => input.calendar!.readForPlan()); } catch { /* An unavailable private cache stays unconfirmed. */ }
      if (calendar && (calendar.ownerUserId !== input.userId || calendar.binding.ownerUserId !== input.userId || calendar.cache.ownerUserId !== input.userId)) throw new Error('本人のCalendar情報を確認してください。');
      let localCalendar: { ownerUserId: string; availability: PrivateCalendarAvailability } | undefined;
      if (input.localCalendar) try { localCalendar = await traceStartup('display.localCalendar', () => input.localCalendar!.readForPlan(model.plan.range, model.plan.timeZone)); }
      catch { localCalendar = { ownerUserId: input.userId, availability: () => ({ conflict: { kind: 'unknown', reason: 'invalid' }, busyMinutes: null }) }; }
      if (localCalendar && localCalendar.ownerUserId !== input.userId) throw new Error('本人のCalendar情報を確認してください。');
      const sharedCalendar = sharedCalendarAvailability(calendarRecords, input.groupId, model.plan.range, model.plan.timeZone);
      if (sharedCalendar) localCalendar = { ownerUserId: input.userId,
        availability: combinePrivateCalendarAvailability(localCalendar?.availability, sharedCalendar) };
      let privateOverlay: V2PrivateOverlayState | undefined;
      if (input.privateTasks && !options?.management) try {
        await traceStartup('display.mirror', () => input.privateTasks!.mirrorShared?.(v2CommonCompletionSource(model)));
        privateOverlay = await traceStartup('display.personalOverlay', () => input.privateTasks!.read(model.plan.range, instant, model.plan.chores));
        if (privateOverlay.ownerUserId !== input.userId) throw new Error('本人の個人家事を確認してください。');
      } catch { privateOverlay = { status: 'unavailable', message: '個人家事を取得できませんでした。個人の状態を確認し、再読込してください。' }; }
      const privateLoad = privateOverlay?.status === 'ready' && privateOverlay.timeZone === model.plan.timeZone
        ? { ownerUserId: input.userId, days: privateOverlay.dailyLoad } : undefined;
      const personal = await traceStartup('display.personalPlan', () => buildV2PersonalPlan(model.plan, { viewerUserId: input.userId, now: instant.getTime(), settings: preferences.settings, privateLoad, localCalendar,
        ...(calendar ? { calendar: { cache: calendar.cache, binding: calendar.binding } } : {}) }));
      return { ...model, personal, ...(privateOverlay ? { privateOverlay } : {}) };
    } };
}
