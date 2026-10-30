import { addDays, daysBetween, parseLocalDate, weekdayOf } from '../../../domain/scheduling/local-date.ts';
import { calendarPenaltyForChore } from '../../../domain/scheduling/calendar-penalty.ts';
import type { ScheduleSettings } from '../../../domain/scheduling/contracts.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { sharedDateAtTime } from '../group-clock.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { compareOperationIds } from '../operations.ts';
import type { V2CommonPlan, V2SubjectPlan, V2PlannedOccurrence } from './common-plan.ts';
import type { PrivateBusyCache, PrivateBusyBinding, CalendarConflict, PrivateCalendarAvailability } from './private-availability.ts';
import { combinePrivateCalendarAvailability, createPrivateCalendarAvailability } from './private-availability.ts';
import { targetReferenceCivilDate } from './date-target.ts';

export interface V2PersonalDayLoad { heavy: number; normal: number; total: number }
export interface V2Recommendation {
  occurrenceId: string; subjectOccurrenceId: string; date: LocalDate;
  state: 'completed' | 'manual' | 'recommended' | 'review' | 'cooldown' | 'expired' | 'otherAssignee';
  calendar: CalendarConflict; reasons: string[];
}
export interface V2PersonalPlan { groupId: string; viewerUserId: string; commonPlanHash: string; recommendations: V2Recommendation[]; localHash: string }

/** Local-only output. No personal preference, Calendar cache, or recommendation is written back into a shared rule or hash. */
export function buildV2PersonalPlan(common: V2CommonPlan, input: {
  viewerUserId: string; settings: ScheduleSettings; now: number;
  privateLoad?: { ownerUserId: string; days: Readonly<Partial<Record<LocalDate, V2PersonalDayLoad>>> };
  calendar?: { cache: PrivateBusyCache | null; binding: PrivateBusyBinding };
  localCalendar?: { ownerUserId: string; availability: PrivateCalendarAvailability };
}): V2PersonalPlan {
  if (!common.members.some((member) => member.userId === input.viewerUserId && member.active)) throw new Error('本人の参加状態を確認してください。');
  if (input.privateLoad && input.privateLoad.ownerUserId !== input.viewerUserId) throw new Error('本人以外の個人予定は参照できません。');
  if (input.localCalendar && input.localCalendar.ownerUserId !== input.viewerUserId) throw new Error('本人のCalendar情報を確認してください。');
  const limits = input.settings.loadLimits;
  if (![limits.heavyDailyLimit, limits.normalDailyLimit].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 100)
    || !input.settings.restDays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7) || !Number.isFinite(input.now)) throw new Error('本人の予定設定を確認してください。');
  const unknown: CalendarConflict = { kind: 'unknown', reason: input.calendar && input.calendar.binding.ownerUserId !== input.viewerUserId ? 'binding' : 'missing' };
  const availability = combinePrivateCalendarAvailability(input.calendar ? input.calendar.binding.ownerUserId === input.viewerUserId
    ? createPrivateCalendarAvailability(input.calendar.cache, input.calendar.binding, input.now) : () => ({ conflict: unknown, busyMinutes: null }) : undefined, input.localCalendar?.availability);
  const daily = new Map<LocalDate, ReturnType<typeof availability>>();
  function dayAvailability(date: LocalDate) {
    let result = daily.get(date); if (result) return result;
    try { result = availability({ precision: 'interval', start: sharedDateAtTime(date, 0, 0, common.timeZone).toISOString(), end: sharedDateAtTime(addDays(date, 1), 0, 0, common.timeZone).toISOString() }); }
    catch { result = { conflict: { kind: 'unknown', reason: 'invalid' }, busyMinutes: null }; }
    daily.set(date, result); return result;
  }
  const loads = new Map<LocalDate, V2PersonalDayLoad>();
  for (const [date, value] of Object.entries(input.privateLoad?.days ?? {})) {
    parseLocalDate(date as LocalDate);
    if (!value || ![value.heavy, value.normal, value.total].every((count) => Number.isSafeInteger(count) && count >= 0)
      || value.heavy + value.normal > value.total) throw new Error('本人の負荷集計を確認してください。');
    loads.set(date as LocalDate, { ...value });
  }
  const chores = new Map(common.chores.map((chore) => [chore.id, chore]));
  const recommendations: V2Recommendation[] = [];
  function reserve(date: LocalDate, load: 'heavy' | 'normal' | 'light') {
    const state = loads.get(date) ?? { heavy: 0, normal: 0, total: 0 }; const next = { ...state, total: state.total + 1 };
    if (load !== 'light') next[load]++; loads.set(date, next);
  }
  function owns(occurrence: V2PlannedOccurrence, subject: V2SubjectPlan) {
    return subject.subjectUserId !== null ? subject.subjectUserId === input.viewerUserId
      : occurrence.assigneeIds.length === 0 || occurrence.assigneeIds.includes(input.viewerUserId);
  }
  const entries = common.occurrences.flatMap((occurrence) => occurrence.subjects.filter((subject) => subject.required).map((subject) => ({ occurrence, subject })));
  entries.sort((a, b) => {
    const fixed = (slot: V2SubjectPlan) => slot.formalDate.kind === 'manual' && slot.formalDate.mode !== 'deadline' ? 0 : 1;
    const weight = (id: string) => ({ heavy: 0, normal: 1, light: 2 })[chores.get(id)?.load ?? 'normal'];
    return fixed(a.subject) - fixed(b.subject) || compareOperationIds(a.subject.executionWindowEnd, b.subject.executionWindowEnd)
      || weight(a.occurrence.choreId) - weight(b.occurrence.choreId) || compareOperationIds(a.subject.id, b.subject.id);
  });
  for (const { occurrence, subject } of entries) {
    const load = chores.get(occurrence.choreId)?.load ?? 'normal'; const reasons: string[] = [];
    let date = subject.suggestedDate; let state: V2Recommendation['state'] = 'recommended'; let calendar: CalendarConflict = unknown;
    if (!owns(occurrence, subject)) state = 'otherAssignee';
    else if (subject.completed) state = 'completed';
    else if (subject.dependencyBlocked || subject.requestReviewIds.length || subject.pendingCompletionIds.length || !occurrence.activeInPeriod
      || subject.formalDate.kind === 'conflict' || subject.formalDate.kind === 'review' || occurrence.needsAssignment) state = 'review';
    else if (subject.cooldownSuppressed) state = 'cooldown';
    else if (subject.executionWindowEnd < common.range.asOfDate) state = 'expired';
    else if (subject.formalDate.kind === 'manual' && subject.formalDate.mode !== 'deadline') {
      state = 'manual'; calendar = availability(subject.formalDate.target).conflict; reserve(date, load);
    } else {
      const start = [subject.executionWindowStart, common.range.asOfDate, common.range.from, subject.minimumNextExecutionDay, subject.dependencyNotBefore]
        .filter((value): value is LocalDate => value !== null).sort().at(-1)!;
      let end = subject.executionWindowEnd < common.range.through ? subject.executionWindowEnd : common.range.through;
      if (subject.formalDate.kind === 'manual' && subject.formalDate.mode === 'deadline') {
        const deadline = targetReferenceCivilDate(subject.formalDate.target, subject.formalDate.timeZone, common.timeZone); if (deadline < end) end = deadline;
      }
      let best: { date: LocalDate; score: number[] } | null = null;
      for (let candidate = start; candidate <= end; candidate = addDays(candidate, 1)) {
        const current = loads.get(candidate) ?? { heavy: 0, normal: 0, total: 0 }; const busy = dayAvailability(candidate);
        const overflow = load === 'heavy' ? Math.max(0, current.heavy + 1 - limits.heavyDailyLimit) * 100
          : load === 'normal' ? Math.max(0, current.normal + 1 - limits.normalDailyLimit) * 20 : 0;
        const score = [overflow, chores.get(occurrence.choreId)?.holidayPriority && input.settings.restDays.length && !input.settings.restDays.includes(weekdayOf(candidate)) ? 1 : 0,
          calendarPenaltyForChore(load, busy.busyMinutes ?? undefined) + Math.abs(daysBetween(occurrence.anchorDate, candidate)), current.total,
          Math.abs(daysBetween(occurrence.anchorDate, candidate))];
        if (!best || score.some((value, index) => value < best!.score[index] && score.slice(0, index).every((prior, offset) => prior === best!.score[offset]))) best = { date: candidate, score };
      }
      if (!best) { state = 'review'; reasons.push('noFeasibleDay'); }
      else { date = best.date; calendar = dayAvailability(date).conflict; reserve(date, load); if (date !== subject.suggestedDate) reasons.push('personalRecommendation'); }
    }
    if (state === 'manual' && calendar.kind === 'conflict') reasons.push('calendarConflict');
    if (['manual', 'recommended'].includes(state) && calendar.kind === 'unknown') reasons.push('calendarUnconfirmed');
    const current = loads.get(date);
    if (current && (load === 'heavy' && current.heavy > limits.heavyDailyLimit || load === 'normal' && current.normal > limits.normalDailyLimit)) reasons.push('dailyLoadExceeded');
    recommendations.push({ occurrenceId: occurrence.id, subjectOccurrenceId: subject.id, date, state, calendar, reasons });
  }
  recommendations.sort((a, b) => compareOperationIds(a.subjectOccurrenceId, b.subjectOccurrenceId));
  const pages: string[] = [];
  for (let offset = 0; offset < recommendations.length; offset += 1000) pages.push(sharedDocumentDigest(recommendations.slice(offset, offset + 1000)));
  return { groupId: common.groupId, viewerUserId: input.viewerUserId, commonPlanHash: common.planHash, recommendations,
    localHash: sharedDocumentDigest({ commonPlanHash: common.planHash, viewerUserId: input.viewerUserId, pages }) };
}
