import { assertSharedIdentifier } from '../identifier.ts';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types';
import { isSharedTimeZone, sharedLocalDate } from '../group-clock.ts';

export interface V2RetainedAssignmentCut { keyVersion: number; context: Record<string, number>; receiptContext: Record<string, number> }

export interface V2RetentionAnchor {
  choreId: string; subjectUserId: string | null; date: LocalDate;
  /** Minimal current completion state for prerequisite evaluation, without performer/instruction/history. */
  anchorDate: LocalDate; ruleVersion: number; instant: number; through: LocalDate;
}
export interface V2RetainedRoundState extends V2RetentionAnchor {
  suggestedDate: LocalDate; windowStart: LocalDate;
  reports: { recorderUserId: string; instant: number }[];
  assignmentCut: V2RetainedAssignmentCut | null;
  strictInstructionUnfulfilled: boolean;
}
export interface V2RetentionBody {
  format: 1 | 2; groupId: string; rosterDigest: string; keyVersion: number; cutoff: LocalDate; timeZone: string;
  frontier: Record<string, number>; throughSequence: number;
  sourceFactsDigest: string; retainedFactsDigest: string; indexDigest: string;
  anchors: V2RetentionAnchor[];
  roundStates: V2RetainedRoundState[];
  retainedCount: number;
  /** Two bits per retained fact: accepted / denied / conflict / awaiting receipt. */
  authorityStates: string;
}
function record(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error('Invalid history-retention fields');
}
const hash = (value: unknown) => { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new Error('Invalid history-retention digest'); };
const count = (value: unknown, min = 0) => { if (!Number.isSafeInteger(value) || Number(value) < min) throw new Error('Invalid history-retention counter'); };
function vector(value: unknown, maximum?: Record<string, number>): asserts value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 256) throw new Error('Invalid retained causal cut');
  for (const [device, number] of Object.entries(value)) { assertSharedIdentifier(device); count(number);
    if (maximum && Number(number) > (maximum[device] ?? 0)) throw new Error('Retained causal cut is outside its certificate'); }
}
export function validateV2RetentionBody(value: unknown): V2RetentionBody {
  record(value, ['format', 'groupId', 'rosterDigest', 'keyVersion', 'cutoff', 'timeZone', 'frontier', 'throughSequence', 'sourceFactsDigest', 'retainedFactsDigest', 'indexDigest', 'anchors', 'roundStates', 'retainedCount', 'authorityStates']);
  if (![1, 2].includes(Number(value.format)) || typeof value.format !== 'number' || !isSharedTimeZone(String(value.timeZone))) throw new Error('Invalid history-retention format or region');
  assertSharedIdentifier(value.groupId); hash(value.rosterDigest); hash(value.sourceFactsDigest); hash(value.retainedFactsDigest); hash(value.indexDigest);
  count(value.keyVersion, 1); count(value.throughSequence); parseLocalDate(value.cutoff as LocalDate);
  vector(value.frontier);
  for (const collection of ['anchors', 'roundStates'] as const) {
  if (!Array.isArray(value[collection]) || value[collection].length > 4096) throw new Error('Invalid history-retention anchors');
  const seen = new Set<string>();
  for (const anchor of value[collection]) {
    record(anchor, ['choreId', 'subjectUserId', 'date', 'anchorDate', 'ruleVersion', 'instant', 'through', ...(collection === 'roundStates' ? ['reports', 'suggestedDate', 'windowStart', 'assignmentCut', 'strictInstructionUnfulfilled'] : [])]);
    assertSharedIdentifier(anchor.choreId); if (anchor.subjectUserId !== null) assertSharedIdentifier(anchor.subjectUserId);
    parseLocalDate(anchor.date as LocalDate); parseLocalDate(anchor.anchorDate as LocalDate); parseLocalDate(anchor.through as LocalDate); count(anchor.ruleVersion, 1); count(anchor.instant);
    if (!Number.isFinite(new Date(Number(anchor.instant)).getTime()) || sharedLocalDate(new Date(Number(anchor.instant)), String(value.timeZone)) !== anchor.date) throw new Error('Retained date differs from its instant');
    const id = `${anchor.choreId}\0${anchor.subjectUserId}${collection === 'roundStates' ? `\0${anchor.anchorDate}` : ''}`;
    if (seen.has(id) || String(anchor.date) >= String(value.cutoff)) throw new Error('Duplicate or unexpired history-retention anchor'); seen.add(id);
    if (collection === 'roundStates') {
      parseLocalDate(anchor.suggestedDate as LocalDate); parseLocalDate(anchor.windowStart as LocalDate);
      if (String(anchor.windowStart) > String(anchor.through) || String(anchor.suggestedDate) < String(anchor.windowStart) || String(anchor.suggestedDate) > String(anchor.through)
        || typeof anchor.strictInstructionUnfulfilled !== 'boolean') throw new Error('Invalid retained execution window');
      if (anchor.assignmentCut !== null) {
        record(anchor.assignmentCut, ['keyVersion', 'context', 'receiptContext']); count(anchor.assignmentCut.keyVersion, 1);
        if (Number(anchor.assignmentCut.keyVersion) > Number(value.keyVersion)) throw new Error('Invalid retained membership epoch');
        vector(anchor.assignmentCut.context, value.frontier); vector(anchor.assignmentCut.receiptContext, anchor.assignmentCut.context);
      }
      if (!Array.isArray(anchor.reports) || anchor.reports.length > 4096) throw new Error('Invalid retained completion state');
      const recorders = new Set<string>();
      for (const report of anchor.reports) { record(report, ['recorderUserId', 'instant']); assertSharedIdentifier(report.recorderUserId); count(report.instant);
        if (!Number.isFinite(new Date(Number(report.instant)).getTime()) || sharedLocalDate(new Date(Number(report.instant)), String(value.timeZone)) >= String(value.cutoff)) throw new Error('Retained report has not expired');
        if (recorders.has(report.recorderUserId as string)) throw new Error('Duplicate retained completion state'); recorders.add(report.recorderUserId as string); }
      if (anchor.reports.length && Math.min(...anchor.reports.map(report => Number(report.instant))) !== anchor.instant) throw new Error('Invalid current completion instant');
    }
  }
  }
  count(value.retainedCount);
  if (Number(value.retainedCount) > 200000 || typeof value.authorityStates !== 'string' || !/^[0-9a-f]*$/u.test(value.authorityStates)
    || value.authorityStates.length !== Math.ceil(Number(value.retainedCount) / 2)
    || Number(value.retainedCount) % 2 && (parseInt(value.authorityStates.at(-1)!, 16) & 3)) throw new Error('Invalid retained authority index');
  return value as unknown as V2RetentionBody;
}
export function validateV2RetentionPayload(value: unknown) {
  if (value && typeof value === 'object' && 'phase' in value && value.phase === 'proposal') {
    record(value, ['phase', 'checkpoint']); validateV2RetentionBody((value as Record<string, unknown>).checkpoint); return;
  }
  record(value, ['phase', 'proposalId', 'checkpointDigest', 'receiptDigest']);
  if (value.phase !== 'approve') throw new Error('Invalid history-retention phase');
  assertSharedIdentifier(value.proposalId); hash(value.checkpointDigest); hash(value.receiptDigest);
}

export function v2RetentionAuthorityState(body: V2RetentionBody, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= body.retainedCount) throw new Error('Invalid retained authority position');
  const value = parseInt(body.authorityStates[Math.floor(index / 2)], 16); return index % 2 ? value & 3 : value >> 2;
}

/** Format 1 keeps its original signed ordering; new certificates never depend on device locale. */
export function compareRetentionValues(format: V2RetentionBody['format'], left: string, right: string): number {
  return format === 1 ? left.localeCompare(right) : left < right ? -1 : left > right ? 1 : 0;
}
