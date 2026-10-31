import type { EntityId, ISODateTime } from '@/domain/shared/types';

export interface ApplianceCareAnalysisRequest {
  householdId: EntityId;
  manufacturer: string;
  model: string;
  category?: string;
  officialMaterialUrl?: string;
}

export interface OfficialSourceEvidence {
  url: string;
  pageOrSection?: string;
}

export interface ApplianceCareTaskDraft {
  name: string;
  recommendedIntervalDays?: number;
  recommendedConditions?: string[];
  steps: string[];
  tools: string[];
  safetyCautions: string[];
  estimatedMinutes?: number;
  evidence: OfficialSourceEvidence[];
}

export interface ApplianceCareAnalysisDraft {
  manufacturer: string;
  model: string;
  tasks: ApplianceCareTaskDraft[];
  analyzedAt: ISODateTime;
  requiresUserReview: true;
  manualSource?: { kind: 'user_upload'; sha256: string };
}

/** A locally saved appliance and the latest user-reviewed manufacturer analysis. */
export interface Appliance {
  id: EntityId;
  householdId: EntityId;
  manufacturer: string;
  productName: string;
  modelNumber: string;
  category?: string;
  displayName: string;
  officialProductUrl?: string;
  officialManualUrl: string;
  analysis: ApplianceCareAnalysisDraft;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** Adapter contract only. No AI provider or document-fetching behavior is selected yet. */
export interface ApplianceCareAnalyzer {
  analyze(request: ApplianceCareAnalysisRequest): Promise<ApplianceCareAnalysisDraft>;
}
