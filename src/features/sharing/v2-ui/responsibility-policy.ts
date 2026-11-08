import type { SharedChorePolicy, SharedChoreRotation } from '../v2/model.ts';

/** Invalid drafts stay visible locally and are never queued as shared configuration. */
export function responsibilityPolicyError(policy: SharedChorePolicy): string | null {
  if (policy.assignment.mode === 'selected' && !policy.assignment.memberIds.length) return '担当者を選んでください。';
  const rotation = policy.assignment.rotation;
  if (rotation && (rotation.sequence.length < 2 || rotation.sequence.length > 64 || new Set(rotation.sequence).size < 2)) return '交代するメンバーを2人以上選んでください。';
  return null;
}
export function rotationDraft(sequence: readonly string[], advanceOn: SharedChoreRotation['advanceOn'] = 'completion'): SharedChorePolicy {
  return { completion: 'one', assignment: { mode: 'selected', memberIds: [...new Set(sequence)].sort(), rotation: { sequence: [...sequence], advanceOn } } };
}
export function cloneResponsibilityPolicy(policy: SharedChorePolicy): SharedChorePolicy {
  return { ...policy, assignment: { ...policy.assignment, memberIds: [...policy.assignment.memberIds],
    ...(policy.assignment.rotation ? { rotation: { ...policy.assignment.rotation, sequence: [...policy.assignment.rotation.sequence] } } : {}) } };
}
