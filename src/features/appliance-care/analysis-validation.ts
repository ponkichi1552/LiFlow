import { matchesUploadedManual } from './manual-source.ts';
import type { ApplianceCareAnalysisDraft } from './contracts';
import { isOfficialApplianceUrl } from './official-url.ts';

export const isAnalysisRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const nonemptyAnalysisString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const strings = (value: unknown, verified: boolean): value is string[] => Array.isArray(value)
  && value.every(item => verified ? nonemptyAnalysisString(item) : typeof item === 'string');

function analysisShape(value: unknown, verified: boolean, manufacturer?: string): boolean {
  if (!isAnalysisRecord(value) || typeof value.analyzedAt !== 'string' || !Array.isArray(value.tasks)) return false;
  if (verified && (!nonemptyAnalysisString(value.manufacturer) || !nonemptyAnalysisString(value.model)
    || !Number.isFinite(Date.parse(value.analyzedAt)) || value.requiresUserReview !== true || value.tasks.length < 1 || value.tasks.length > 40)) return false;
  if (verified && value.manualSource !== undefined && (!isAnalysisRecord(value.manualSource) || value.manualSource.kind !== 'user_upload' || typeof value.manualSource.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.manualSource.sha256))) return false;
  return value.tasks.every(task => isAnalysisRecord(task) && (verified ? nonemptyAnalysisString(task.name) : typeof task.name === 'string')
    && strings(task.steps, verified) && (!verified || task.steps.length > 0) && strings(task.tools, verified) && strings(task.safetyCautions, verified)
    && (task.recommendedConditions === undefined || strings(task.recommendedConditions, verified))
    && (task.recommendedIntervalDays === undefined || typeof task.recommendedIntervalDays === 'number'
      && Number.isInteger(task.recommendedIntervalDays) && task.recommendedIntervalDays > 0 && task.recommendedIntervalDays <= 3650)
    && (task.estimatedMinutes === undefined || typeof task.estimatedMinutes === 'number' && Number.isFinite(task.estimatedMinutes) && task.estimatedMinutes >= 0)
    && Array.isArray(task.evidence) && (!verified || task.evidence.length > 0) && task.evidence.every(source => isAnalysisRecord(source)
      && (verified ? nonemptyAnalysisString(source.url) : typeof source.url === 'string')
      && (source.pageOrSection === undefined || typeof source.pageOrSection === 'string')
      && (!verified || (value.manualSource === undefined ? isOfficialApplianceUrl(source.url as string, manufacturer!) : matchesUploadedManual(source.url, value)))));
}

/** Legacy stored data may lack review metadata or have no tasks. Do not reinterpret it as a newly verified response. */
export function isRenderableApplianceAnalysis(value: unknown): value is Pick<ApplianceCareAnalysisDraft, 'tasks' | 'analyzedAt'> {
  return analysisShape(value, false);
}

/** Newly received API data keeps the original review, source, count and cadence requirements. */
export function isVerifiedApplianceAnalysis(value: unknown, manufacturer: string): value is ApplianceCareAnalysisDraft {
  return analysisShape(value, true, manufacturer);
}
