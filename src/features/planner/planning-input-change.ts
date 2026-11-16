export const PLANNING_INPUT_CHANGED_CODE = 'planning_input_changed';

/** A captured plan must be discarded before retrying with current protected inputs. */
export class PlanningInputChangedError extends Error {
  readonly code = PLANNING_INPUT_CHANGED_CODE;
  constructor() {
    super('本人の予定が更新されました。読み直してください。');
    this.name = 'PlanningInputChangedError';
  }
}
