import { restoreManualDocument } from '../../appliance-care/manual-document.ts';
import type { ManualDocument, ManualChunk, SavedManual } from '../../appliance-care/manual-document';
import type { SharedOperation } from '../operations';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger';
import type { V2HistoryView } from './history-view';

export function readV2ManualDocument(view: V2HistoryView, at: SharedOperation, digest: string): string | null {
  const manifest = view.observed(view.topic('manualDocument', `manual.${digest}`), at)[0];
  if (!manifest) return null;
  return restoreManualDocument(manifest.payload as unknown as ManualDocument, id => {
    const chunk = view.observed(view.topic('manualChunk', `manual-chunk.${id}`), at)[0];
    return chunk?.payload as unknown as ManualChunk | undefined;
  });
}
/** Content-addressed immutable facts reuse the normal signed, encrypted outbox and snapshot. */
export function manualDocumentDrafts(view: V2HistoryView, manual: SavedManual, makeId: () => string): SharedOperationDraft[] {
  const drafts: SharedOperationDraft[] = []; const seen = new Set<string>();
  for (const chunk of manual.chunks) {
    if (seen.has(chunk.sha256)) continue; seen.add(chunk.sha256);
    const entityId = `manual-chunk.${chunk.sha256}`;
    if (!view.topic('manualChunk', entityId).length) drafts.push({ operationId: makeId(), entityType: 'manualChunk', entityId, operationType: 'patch', payload: { ...chunk } });
  }
  const entityId = `manual.${manual.document.sha256}`;
  if (!view.topic('manualDocument', entityId).length) drafts.push({ operationId: makeId(), entityType: 'manualDocument', entityId, operationType: 'patch', payload: { ...manual.document } });
  return drafts;
}
