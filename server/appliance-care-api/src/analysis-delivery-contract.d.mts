export interface AnalysisDeliveryReceipt { token: string; digest: string; expiresAt: number }
export function analysisDeliveryJson(value: unknown): string;
export function validAnalysisDelivery(value: unknown): value is AnalysisDeliveryReceipt;
