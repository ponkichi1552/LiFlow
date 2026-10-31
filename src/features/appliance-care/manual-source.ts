import type { ApplianceCareAnalysisDraft } from './contracts';

export const isUploadedManualReference = (value: unknown): value is string => typeof value === 'string'
  && /^liflow-manual:\/\/sha256\/[a-f0-9]{64}$/u.test(value);

/** A digest identifies the submitted bytes; it is not an official URL or proof of the manufacturer's approval. */
export function matchesUploadedManual(reference: unknown, analysis: unknown): boolean {
  if (!isUploadedManualReference(reference) || !analysis || typeof analysis !== 'object') return false;
  const source = (analysis as ApplianceCareAnalysisDraft).manualSource;
  return source?.kind === 'user_upload' && /^[a-f0-9]{64}$/u.test(source.sha256) && reference.endsWith(source.sha256);
}
