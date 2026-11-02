import { dateTaskOccurrenceReference } from '../../domain/scheduling/date-task-reference.ts';
import type { PersonalDateTaskCommand } from '../../domain/scheduling/date-task-reference';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { assertSharedIdentifier } from '../sharing/identifier.ts';
import type { V2RoundReference } from '../sharing/v2/actions';
import type { CompletionIntent } from './completion-intents';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export type PersonalCompletionTarget = { kind: 'personal'; command: Omit<PersonalDateTaskCommand, 'completed'> };
export type SharedCompletionTarget = { kind: 'shared'; ref: V2RoundReference; expectedAssigneeIds: string[] };
export type CompletionTarget = PersonalCompletionTarget | SharedCompletionTarget;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('完了操作を確認できません。');
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !('value' in field))) throw new Error('完了操作を確認できません。');
  return value as Record<string, unknown>;
}
function identifiers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('完了操作の対象を確認できません。');
  return value.map(item => { assertSharedIdentifier(item); return item; });
}
export function captureCompletionTarget(value: CompletionTarget): CompletionTarget {
  const target = record(value);
  if (target.kind === 'personal') {
    const command = record(target.command);
    if (typeof command.date !== 'string' || typeof command.revision !== 'string' || command.revision.length > 10000
      || !dateTaskOccurrenceReference(command.revision) || command.graceDays !== 0 && command.graceDays !== 3) throw new Error('個人家事を選び直してください。');
    parseLocalDate(command.date as PersonalDateTaskCommand['date']); assertSharedIdentifier(command.choreId);
    return { kind: 'personal', command: { date: command.date as PersonalDateTaskCommand['date'], graceDays: command.graceDays,
      choreId: command.choreId, revision: command.revision } };
  }
  if (target.kind !== 'shared') throw new Error('完了操作の保存先を確認できません。');
  const ref = record(target.ref); assertSharedIdentifier(ref.choreId);
  if (typeof ref.anchorDate !== 'string' || !Number.isSafeInteger(ref.ruleVersion) || Number(ref.ruleVersion) < 1) throw new Error('共有家事を選び直してください。');
  parseLocalDate(ref.anchorDate as V2RoundReference['anchorDate']);
  if (ref.subjectUserId !== null) assertSharedIdentifier(ref.subjectUserId);
  if (ref.expectedTimeZone !== undefined && (typeof ref.expectedTimeZone !== 'string' || ref.expectedTimeZone.length > 100)) throw new Error('共有家事の地域を確認できません。');
  return { kind: 'shared', ref: { choreId: ref.choreId, anchorDate: ref.anchorDate as V2RoundReference['anchorDate'],
    ruleVersion: Number(ref.ruleVersion), subjectUserId: ref.subjectUserId,
    ...(ref.expectedConfigurationIds !== undefined ? { expectedConfigurationIds: identifiers(ref.expectedConfigurationIds) } : {}),
    ...(ref.expectedTimeZone !== undefined ? { expectedTimeZone: ref.expectedTimeZone as string } : {}) },
    expectedAssigneeIds: identifiers(target.expectedAssigneeIds) };
}
export function personalCompletionKey(revision: string) {
  const reference = dateTaskOccurrenceReference(revision);
  if (!reference) throw new Error('個人家事の回を確認できません。');
  return `personal-intent:${reference}`;
}
export function completionIntentDigest(scope: string, intent: Readonly<CompletionIntent<CompletionTarget>>) {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(['liflow-local-completion-intent-v1', scope, intent.id, intent.key,
    captureCompletionTarget(intent.target), intent.completed, intent.createdAt]))));
}
