import { applianceCareApiBaseUrl, analysisReceiptRetryAt, flushAnalysisReceipts } from '../../features/appliance-care/api-client';
import type { DeviceAnalysisDeliveryStore } from '../storage/analysis-deliveries';
import { getSharingServices, isSharingConfigured } from '../sharing/firebase-services';
import { authorizeApplianceCareApi } from './auth';

export async function recoverNativeAnalysisReceipts(store: DeviceAnalysisDeliveryStore, options: { expectedOwner?: string; background?: boolean } = {}): Promise<boolean | { retryAt: number }> {
  if (!process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim() || !isSharingConfigured()) return false;
  const baseUrl = applianceCareApiBaseUrl(); if (!baseUrl.startsWith('https://')) return false;
  const auth = getSharingServices().auth; await auth.authStateReady(); const user = auth.currentUser;
  if (!user || user.isAnonymous || options.expectedOwner && user.uid !== options.expectedOwner
    || !(await store.pending(user.uid, baseUrl)).some(item => item.baseUrl === baseUrl)) return false;
  const retryAt = analysisReceiptRetryAt(store, user.uid, baseUrl); if (retryAt > Date.now()) return { retryAt };
  const session = await authorizeApplianceCareApi(baseUrl);
  if (session.userId !== user.uid || auth.currentUser !== user) return false;
  await flushAnalysisReceipts(store, session, baseUrl, options.background);
  return (await store.pending(user.uid, baseUrl)).some(item => item.baseUrl === baseUrl);
}
