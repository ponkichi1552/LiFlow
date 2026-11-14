import type { SharedCloudEvent } from './cloud-contract';
import type { EncryptedSharedSnapshotChunk } from './crypto';
export interface SharedDeliveryArchive<Artifact = EncryptedSharedSnapshotChunk> {
  saveEvents(events: readonly SharedCloudEvent[]): Promise<void>;
  events(after: number, through: number): Promise<SharedCloudEvent[] | null>;
  saveChunk(id: string, chunk: Artifact): Promise<void>;
  chunk(id: string): Promise<Artifact | null>;
  seedPosition(floor: number): Promise<number>;
}
export class SharedDeliveryPendingError extends Error {
  readonly code = 'sharing/delivery-pending';
  constructor() { super('最新データを持つ端末から受信を待っています。'); }
}
