import type { ChoreDefinition, FrequencyMode } from '../../domain/chores/types';
import type { AdaptiveHistoryState } from '../../domain/scheduling/adaptive/history';
import { adaptiveNextIntervalDays, adaptiveRepresentativeDays, roundedAdaptiveDays } from '../../domain/scheduling/adaptive/models.ts';
import { adaptiveWindowRadius } from '../../domain/scheduling/adaptive/placement.ts';
import { choreCadenceLabel } from '../../domain/chores/cycle-policy.ts';

/** Derived display only. Never persist learned parameters in a user override or a shared definition. */
export interface PersonalCadenceView { mode: FrequencyMode; days: number | null; label: string; automatic: boolean; windowRadiusDays: number }
export function personalCadenceView(chore: ChoreDefinition, state: AdaptiveHistoryState): PersonalCadenceView {
  const model = state.model; const anchor = state.lastPlanCompletion?.date ?? state.policy.planningAnchorDate;
  const days = model ? roundedAdaptiveDays(anchor ? adaptiveNextIntervalDays(model, anchor) : adaptiveRepresentativeDays(model)) : null;
  const label = !model ? choreCadenceLabel(chore, state.policy.mode)
    : model.method === 'weekly' ? `${model.weeks === 1 ? '毎週' : `${model.weeks}週間ごとの`}${['月', '火', '水', '木', '金', '土', '日'][model.weekday - 1]}曜日`
      : model.method === 'monthEnd' ? model.months === 1 ? '毎月末' : `${model.months}か月ごとの月末`
        : model.method === 'alternating' ? `${roundedAdaptiveDays(model.even)}日・${roundedAdaptiveDays(model.odd)}日ごと`
          : days === 1 ? '毎日' : `${days}日ごと`;
  return { mode: state.policy.mode, days, label, automatic: state.policy.fixedDays === null,
    windowRadiusDays: chore.userWindowRadiusDays ?? (days === null ? 0 : adaptiveWindowRadius(days)) };
}
