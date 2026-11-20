import { doc, getDocFromServer, runTransaction, serverTimestamp } from 'firebase/firestore';
import type { DocumentData, DocumentReference, Firestore } from 'firebase/firestore';
import { DELIVERY_PROOF_COLLECTION, parseDeliveryPolicy, signDeliveryProgress } from '../../features/sharing/delivery-proof.ts';
import type { DeliveryScope, DeviceDeliverySigner, PrivateDeliveryProgress, SharedDeliveryProgress } from '../../features/sharing/delivery-proof.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';

export interface DeliveryProofClient {
  resolve(groupId: string, policy: unknown, root: DocumentData | undefined): DeliveryScope | null;
  readPolicy(root: DocumentReference): Promise<unknown>;
  sign: DeviceDeliverySigner;
  publish(root: DocumentReference, scope: DeliveryScope, progress: SharedDeliveryProgress | PrivateDeliveryProgress): Promise<void>;
}

export function createDeliveryProofClient(port: {
  firestore: Firestore; kind: DeliveryScope['kind']; userId: string; deviceId: string; check(): void;
  authority(root: DocumentData | undefined): { digest: string; keyVersion: number } | null; sign: DeviceDeliverySigner;
}): DeliveryProofClient {
  const { firestore, check } = port;
  const projectId = firestore.app.options.projectId;
  let written: string | undefined;
  const policyRef = (root: DocumentReference) => doc(root, 'deliveryControl', 'policy');
  function resolve(groupId: string, rawPolicy: unknown, root: DocumentData | undefined): DeliveryScope | null {
    check(); const policy = parseDeliveryPolicy(rawPolicy);
    if (!projectId || !policy) return null;
    const authority = port.authority(root);
    return authority ? { projectId, kind: port.kind, scopeId: groupId, enrollmentId: policy.enrollmentId,
      authorityDigest: authority.digest, keyVersion: authority.keyVersion } : null;
  }
  return {
    resolve,
    async readPolicy(root) { check(); const current = await getDocFromServer(policyRef(root)); check(); return current.data(); },
    sign(value) { check(); return port.sign(value); },
    async publish(root, scope, progress) {
      check();
      const fingerprint = canonicalJson([scope, progress]);
      if (written === fingerprint) return;
      const document = await signDeliveryProgress(scope, port.userId, port.deviceId, progress, port.sign);
      check(); if (written === fingerprint) return;
      await runTransaction(firestore, async transaction => {
        const target = doc(root, DELIVERY_PROOF_COLLECTION, port.deviceId);
        const [current, policy, old] = await Promise.all([transaction.get(root), transaction.get(policyRef(root)), transaction.get(target)]);
        check();
        const actual = resolve(root.id, policy.data(), current.data());
        if (!actual || canonicalJson(actual) !== canonicalJson(scope)) throw new Error('Delivery approval changed');
        if (old.data()?.signature !== document.signature) transaction.set(target, { ...document, updatedAt: serverTimestamp() });
      });
      check(); written = fingerprint;
    },
  };
}
