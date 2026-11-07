import { causallyPrecedes } from '../operations.ts';
import type { ManualRuleFact, SharedOccurrence } from './model.ts';
import type { V2DateRequestState } from './request-state.ts';
import type { V2HistoryView } from './history-view.ts';
import { approvedRequestRuleId } from './formal-rules.ts';
import { manualRuleMatches, ruleSelectorMatches } from './period-rules.ts';
import { counterofferDesignationOptions } from './date-options.ts';

/** A valid historical action does not silently acknowledge an as-yet unseen contradictory answer. */
export function unresolvedRequestReviews(input: { occurrence: SharedOccurrence; subjectUserId: string | null;
  candidates: readonly ManualRuleFact[]; allRules: readonly ManualRuleFact[]; requests: readonly V2DateRequestState[]; view: V2HistoryView }): string[] {
  const applicable = input.requests.filter(state => state.conflictIds.length && state.proposal.choreId === input.occurrence.choreId
    && state.proposal.subjectUserId === input.subjectUserId && ruleSelectorMatches(state.proposal.selector, input.occurrence));
  if (!applicable.length) return [];
  const rules = new Map(input.allRules.map((fact) => [fact.operationId, fact]));
  const result: string[] = [];
  for (const state of applicable) {
    const proposal = state.proposal;
    if (!state.conflictIds.length || proposal.choreId !== input.occurrence.choreId || proposal.subjectUserId !== input.subjectUserId
      || !ruleSelectorMatches(proposal.selector, input.occurrence)) continue;
    const request = input.view.byId(state.requestId); if (!request) continue;
    const possible = new Set([approvedRequestRuleId(request, proposal.proposed),
      ...input.view.requestDecisionsFor(state.requestId).filter((op) => op.payload.decision === 'counteroffer')
        .map((op) => approvedRequestRuleId(request, op.payload.target as unknown as import('./model.ts').DateTarget,
          counterofferDesignationOptions(proposal.proposedOptions, op.payload.allowDuringCooldown)))]);
    let dependsOnDispute = state.kind === 'conflict'; let acknowledged = false;
    const stack = [...input.candidates]; const visited = new Set<string>();
    while (stack.length) {
      const fact = stack.pop()!; if (visited.has(fact.operationId)) continue; visited.add(fact.operationId);
      if (fact.rule.reviewedRequestIds?.includes(state.requestId) && manualRuleMatches(fact, input.occurrence)
        && state.conflictIds.every((id) => { const answer = input.view.byId(id); return answer && causallyPrecedes(answer, fact); })) acknowledged = true;
      for (const id of fact.rule.basisRuleIds ?? []) {
        if (possible.has(id)) dependsOnDispute = true;
        const parent = rules.get(id); if (parent) stack.push(parent);
      }
    }
    if (dependsOnDispute && !acknowledged) result.push(state.requestId);
  }
  return result.sort();
}
