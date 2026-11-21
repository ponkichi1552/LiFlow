import type { ApplianceCareApiRequest, ApplianceCareApiResponse } from './api-contracts';
import type { V2ApplianceReview } from '../sharing/v2/appliance-actions';

export type AnalysisTarget = { groupId?: string; applianceId?: string };
export type SharedAnalysisBasis = Pick<V2ApplianceReview, 'selection' | 'resolveOperationIds' | 'restorePresence'>;

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
  basis?: SharedAnalysisBasis;
  result: ApplianceCareApiResponse | null;
  attempts: number;
  retryAt: number;
  createdAt: number;
}

export function analysisTargetKey(target: AnalysisTarget): string {
  return JSON.stringify([target.groupId ?? null, target.applianceId ?? null]);
}

export function analysisRetryAt(result: ApplianceCareApiResponse, attempts: number, now: number): number | null {
  if (result.status !== 'error' || (result.code !== 'TEMPORARY_NETWORK_ERROR' && result.code !== 'AUTHENTICATION_REQUIRED')) return null;
  return now + Math.min(60_000, 5_000 * 2 ** Math.min(attempts, 4));
}
