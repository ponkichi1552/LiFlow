import type { CompletionTarget } from '../../planner/completion-command';
export interface CompletionFeedback {
  values: ReadonlyMap<string, boolean>;
  supports?(kind: CompletionTarget['kind']): boolean;
  request?(key: string, completed: boolean, target: CompletionTarget): void;
  run(key: string, completed: boolean, work: () => Promise<unknown>): Promise<void>;
}
