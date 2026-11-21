import type { ApplianceCareAnalysisDraft } from '@/features/appliance-care/contracts';

export interface ApplianceCareApiRequest {
  /** Uploaded-manual identification does not require any product input. Saved identities may be supplied for reanalysis matching only. */
  identifyFromManual?: true;
  manufacturer?: string;
  productName?: string;
  modelNumber?: string | null;
  category?: string;
  forceReanalysis?: boolean;
  manual?: UploadedManualInput;
}

export interface UploadedManualInput { base64: string; rightsConfirmed: true }

export interface ProductCandidate {
  manufacturer: string;
  productName: string;
  modelNumber?: string;
  officialProductUrl: string;
}

export interface ProductVerifiedResponse {
  status: 'verified';
  usage?: ApplianceCareUsage;
  product: {
    manufacturer: string;
    productName: string;
    modelNumber: string | null;
    modelPages?: number[];
    category?: string;
  };
  officialSources: {
    productUrl?: string;
    manualUrl: string;
  };
  analysis: ApplianceCareAnalysisDraft;
}

export interface ProductAmbiguousResponse {
  status: 'ambiguous';
  candidates: ProductCandidate[];
}

export interface ProductNotFoundResponse {
  status: 'not_found';
  code?: 'PRODUCT_NOT_FOUND';
  message: string;
}

export interface ProductAnalysisErrorResponse {
  status: 'error';
  code: 'INVALID_REQUEST' | 'RATE_LIMITED' | 'SEARCH_FAILED' | 'MANUAL_NOT_FOUND' | 'MANUAL_FETCH_FAILED'
    | 'AI_SERVICE_NO_RESULT' | 'AI_ANALYSIS_FAILED' | 'INVALID_AI_OUTPUT' | 'PRODUCT_NOT_FOUND' | 'ANALYSIS_FAILED'
    | 'TEMPORARY_NETWORK_ERROR' | 'AUTHENTICATION_REQUIRED' | 'ACCESS_DENIED' | 'SUBSCRIPTION_REQUIRED' | 'MONTHLY_LIMIT_REACHED'
    | 'DEVICE_VERIFICATION_REQUIRED' | 'DEVICE_VERIFICATION_UNAVAILABLE' | 'DEVICE_VERIFICATION_TEMPORARY' | 'REINSTALL_ACCOUNT_LOCKED' | 'INVALID_MANUAL'
    | 'SERVICE_LIMIT_REACHED' | 'JOB_NOT_FOUND' | 'REQUEST_CONFLICT' | 'ANALYSIS_INTERRUPTED' | 'ANALYSIS_INPUT_SECURITY_UNAVAILABLE';
  message: string;
  retryAt?: string;
}

export interface ApplianceCareUsage { limit: number; used: number; remaining: number; resetsAt: string }

export type ApplianceCareApiResponse = (ProductVerifiedResponse
  | ProductAmbiguousResponse
  | ProductNotFoundResponse
  | ProductAnalysisErrorResponse) & { usage?: ApplianceCareUsage };

export type ApplianceCareAnalysisStage = 'product_verification' | 'official_manual_analysis';
