import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
const digest = (parts: string[]) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(parts))));
export function sharedGoogleNamespace(userId: string, groupId: string): string { return digest([userId, groupId]); }
export function sharedGoogleListTitle(namespace: string): string { return `LiFlow 共有 ${namespace.slice(0, 16)}`; }
export function sharedGoogleOccurrenceNote(namespace: string, occurrenceId: string): string { return `LiFlow occurrence: ${digest([namespace, occurrenceId])}`; }
export function personalGoogleOccurrenceNote(subject: string, householdId: string, occurrenceId: string): string {
  return `LiFlow personal occurrence: ${digest([subject, householdId, occurrenceId])}`;
}
export function sharedPlannerChangeScope(userId: string, groupId: string): string { return `sharing:${sharedGoogleNamespace(userId, groupId)}`; }
