import { customChoreInput } from '../../domain/chores/custom-chore';

/** The submit affordance uses the same required-field rules as the persisted command. */
export function customChoreReady(name: string, interval: string | number) {
  try { customChoreInput(name, interval); return true; } catch { return false; }
}
