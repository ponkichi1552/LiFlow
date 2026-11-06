import type { ChoreDefinition, ChoreScheduleEntry } from '../../domain/chores/types';
import type { LocalDate } from '../../domain/shared/types';
import { daysBetween, addDays } from '../../domain/scheduling/local-date.ts';
import type { AdaptiveHistoryState } from '../../domain/scheduling/adaptive/history';
import type { AdaptiveRoundPlacement, AdaptivePlacementLoad, AdaptivePlacementTask } from '../../domain/scheduling/adaptive/placement';
import { initialAdaptiveBaseDate, placeAdaptiveRounds } from '../../domain/scheduling/adaptive/placement.ts';
import { adaptiveRepresentativeDays, adaptiveNextIntervalDays, predictAdaptiveDate, adaptiveModelIsDaily } from '../../domain/scheduling/adaptive/models.ts';
import type { prepareAdaptivePlacementInput } from './adaptive-input';
import { personalChoreUsesWeather } from '../weather/chore-weather.ts';

export interface AdaptiveRoundRequest {
  roundId: string; chore: ChoreDefinition; state: AdaptiveHistoryState; previous: AdaptiveRoundPlacement | null;
  trigger: 'initial' | 'replan' | 'settings' | 'complete' | 'undo';
  /** A whole-mode update protects today's/tomorrow's existing round, unlike a direct individual edit. */
  globalModeChange?: boolean;
}
/** These are allocation slots, never a requested user start time or a new calendar event. */
export function planPersonalAdaptiveRounds(input: {
  requests: readonly AdaptiveRoundRequest[]; geometry: ReturnType<typeof prepareAdaptivePlacementInput>;
  ownerId: string; today: LocalDate; now: number; fixedLoads: readonly AdaptivePlacementLoad[]; fingerprint(value: unknown): string;
}): Map<string, AdaptiveRoundPlacement> {
  const tasks: AdaptivePlacementTask[] = input.requests.map(request => {
    const { state, chore, previous, trigger, roundId } = request; const model = state.model;
    if (!model || !state.policy.enabled || state.policy.kind !== 'personal') throw new Error('定期型の個人家事を確認してください。');
    if (chore.estimatedMinutes !== undefined && (!Number.isFinite(chore.estimatedMinutes) || chore.estimatedMinutes <= 0)) throw new Error('家事の実作業時間を確認してください。');
    if (chore.estimatedMinutes === undefined && !chore.applianceId && !chore.applianceCareSource) throw new Error('家事の実作業時間が未定義です。');
    const anchor = state.lastPlanCompletion?.date ?? state.policy.planningAnchorDate;
    // History already advances the adopted model's calendar phase. The last
    // completion may still carry a rule date issued by a different model.
    const periodDays = anchor ? adaptiveNextIntervalDays(model, anchor) : adaptiveRepresentativeDays(model);
    const baseDate = anchor ? predictAdaptiveDate(model, anchor)
      : previous?.originalBaseDate ?? initialAdaptiveBaseDate({ today: input.today, periodDays, ownerId: input.ownerId,
        choreId: chore.id, version: state.policy.version, fingerprint: input.fingerprint });
    const newlyInitial = !anchor && !previous;
    const purpose = newlyInitial ? 'initial' : trigger === 'replan' || trigger === 'settings' && request.globalModeChange ? 'automatic' : 'nextRound';
    return { id: roundId, choreId: chore.id, baseDate, periodDays, minutes: chore.estimatedMinutes ?? null, load: chore.load,
      purpose, ...(previous ? { previous } : {}), ...(anchor ? { lastCompletedDate: anchor } : {}), fixedDaily: adaptiveModelIsDaily(model),
      windowRadiusDays: chore.userWindowRadiusDays, holidayPriority: chore.holidayPriority, weatherSensitive: personalChoreUsesWeather(chore) };
  });
  const plans = placeAdaptiveRounds({ ...input.geometry, tasks, today: input.today, now: input.now, fixedLoads: input.fixedLoads });
  return new Map(plans.map(plan => [plan.id, plan]));
}

/** Project one durable pending round. Passage of time changes its status, never its identity or model. */
export function adaptiveRoundEntry(input: { chore: ChoreDefinition; plan: AdaptiveRoundPlacement | null;
  state: AdaptiveHistoryState; today: LocalDate; assignedMemberIds: readonly string[] }): ChoreScheduleEntry | null {
  const { chore, plan, state, today } = input;
  if (!plan || !chore.enabled || chore.archived) return null;
  const windowStart = plan.displayedWindow?.from ?? plan.recommendedDate;
  const windowEnd = plan.displayedWindow?.through ?? plan.recommendedDate;
  return { id: plan.id, householdId: chore.householdId, choreId: chore.id, cycleBaseDate: plan.originalBaseDate,
    windowStart, windowEnd, suggestedDate: plan.recommendedDate,
    status: today > windowEnd ? 'overdue' : today >= windowStart ? 'inWindow' : !state.lastPlanCompletion && !state.policy.planningAnchorDate ? 'initialPending' : 'scheduled',
    assignedMemberIds: [...input.assignedMemberIds], ...(today > windowEnd ? { overdueDays: daysBetween(windowEnd, today) } : {}) };
}

/** Existing pending plans on/before tomorrow cannot be recruited by automatic reallocation. */
export function adaptiveRoundIsProtected(plan: AdaptiveRoundPlacement, today: LocalDate, fixedDaily: boolean) {
  return fixedDaily || plan.recommendedDate <= addDays(today, 1);
}
