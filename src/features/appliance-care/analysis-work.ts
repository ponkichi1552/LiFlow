import type { ApplianceCareApiRequest, ApplianceCareApiResponse } from './api-contracts';
import type { V2ApplianceReview } from '../sharing/v2/appliance-actions';

export type AnalysisTarget = { groupId?: string; applianceId?: string };
export type SharedAnalysisBasis = Pick<V2ApplianceReview, 'selection' | 'resolveOperationIds' | 'restorePresence'>;
export type AnalysisWorkBasis = SharedAnalysisBasis & { personalUpdatedAt?: string };

export interface AnalysisWorkSummary extends AnalysisTarget {
  id: string;
  filename?: string;
  state: 'pending' | 'ready' | 'failed';
}

export interface AnalysisWork extends AnalysisWorkSummary {
  owner: string;
  request: Omit<ApplianceCareApiRequest, 'manual'>;
  baseUrl: string;
  manualDigest: string;
  basis?: AnalysisWorkBasis;
  result: ApplianceCareApiResponse | null;
  attempts: number;
  retryAt: number;
  createdAt: number;
  firstAttemptAt?: number;
}

export function analysisTargetKey(target: AnalysisTarget): string {
  return JSON.stringify([target.groupId ?? null, target.applianceId ?? null]);
}

export function analysisRetryAt(result: ApplianceCareApiResponse, attempts: number, now: number): number | null {
  if (result.status !== 'error' || !['TEMPORARY_NETWORK_ERROR', 'AUTHENTICATION_REQUIRED', 'DEVICE_VERIFICATION_TEMPORARY'].includes(result.code)) return null;
  const retryAt = result.code === 'DEVICE_VERIFICATION_TEMPORARY' ? Date.parse(result.retryAt ?? '') : NaN;
  return Math.max(now + Math.min(60_000, 5_000 * 2 ** Math.min(attempts, 4)), Number.isFinite(retryAt) ? retryAt : 0);
}
