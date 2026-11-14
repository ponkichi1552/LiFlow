import type { DocumentReference, Firestore } from 'firebase/firestore';
import type { parseSharedCloudGroup } from '../../features/sharing/cloud-contract';
import type { SharingDeliveryRelay } from './firestore-delivery';

export interface SharingCloudContext {
  firestore: Firestore; userId: string; checkAccount: () => void;
  /** Enable only against verified Rules supporting ownerRecoveryV1. Existing deployments make no new path reads. */
  recoveryEnabled?: boolean;
  deliveryRelay?: () => SharingDeliveryRelay | undefined;
  reference: (groupId: string) => DocumentReference;
  readGroup: (groupId: string) => Promise<ReturnType<typeof parseSharedCloudGroup>>;
}
