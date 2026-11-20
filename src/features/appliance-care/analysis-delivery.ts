import type { ApplianceCareApiResponse, UploadedManualInput } from './api-contracts';
import type { AnalysisDeliveryReceipt } from '../../../server/appliance-care-api/src/analysis-delivery-contract.mjs';

export interface SavedAnalysisDelivery {
  jobId: string; baseUrl: string; receipt: AnalysisDeliveryReceipt;
}
export interface AnalysisAdmission {
  id: string; jobId: string | null;
}
/** save resolves only after the result and its PDF have committed to device storage. */
export interface AnalysisDeliveryStore {
  admission(owner: string, requestKey: string, proposed: string): Promise<AnalysisAdmission>;
  recordJob(owner: string, requestKey: string, id: string, jobId: string): Promise<void>;
  completeAdmission(owner: string, requestKey: string, id: string): Promise<void>;
  read(owner: string, requestKey: string): Promise<ApplianceCareApiResponse | null>;
  save(owner: string, requestKey: string, delivery: SavedAnalysisDelivery, result: ApplianceCareApiResponse, manual?: UploadedManualInput): Promise<void>;
  pending(owner: string): Promise<SavedAnalysisDelivery[]>;
  acknowledged(owner: string, jobId: string): Promise<void>;
}
