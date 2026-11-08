import { addDays } from '../../../domain/scheduling/local-date.ts';
import { v2AnchorIndexBefore, v2AnchorIndexOnOrAfter } from './cadence.ts';
import type { LocalDate } from '../../../domain/shared/types';
import { canonicalJson } from '../operations.ts';
import type { SharedOperation } from '../operations';
import type { SharedChoreConfiguration } from './model';
import type { V2HistoryView } from './history-view';
import { v2CompletionHistory } from './completion-history.ts';
import { v2RetainedCompletions } from './retained-completions.ts';
import { v2ConfigurationTimeline } from './configuration-timeline.ts';
import { markRotationCompletion, rotationCompletionCount, rotationProgressIndex } from './rotation-progress.ts';
import type { V2RotationProgressIndex } from './rotation-progress';

const caches = new WeakMap<V2HistoryView, Map<string, V2RotationProgressIndex>>();
const timelines = new WeakMap<V2HistoryView, Map<string, ReturnType<typeof v2ConfigurationTimeline>>>();
function timeline(view: V2HistoryView, at: SharedOperation, choreId: string) {
  let cache = timelines.get(view); if (!cache) { cache = new Map(); timelines.set(view, cache); }
  const key = canonicalJson([choreId, at.context, view.ready.length]); const known = cache.get(key); if (known) return known;
  const value = v2ConfigurationTimeline(view, choreId, at); cache.set(key, value);
  while (cache.size > 64) cache.delete(cache.keys().next().value!); return value;
}
function completionProgress(view: V2HistoryView, at: SharedOperation): V2RotationProgressIndex {
  const key = canonicalJson([at.context, at.receiptContext ?? null, view.ready.length]);
  let cache = caches.get(view); if (!cache) { cache = new Map(); caches.set(view, cache); }
  const known = cache.get(key); if (known) return known;
  const progress = rotationProgressIndex(view.retentionAt(at)?.rotationProgress);
  const versions = new Map<string, SharedChoreConfiguration | undefined>();
  const source = (choreId: string, version: number) => {
    const id = canonicalJson([choreId, version]); if (!versions.has(id)) versions.set(id, view.configurationVersion(choreId, version, at)?.value as unknown as SharedChoreConfiguration | undefined);
    return versions.get(id);
  };
  const receipts = view.completionReceipts();
  for (const record of v2CompletionHistory(view, at, receipts)) {
    if (!record.active || record.outcome !== 'completed' || record.acceptance !== 'accepted' || receipts.has(record.operationId) && !record.performedTimeConfirmed) continue;
    const op = view.byId(record.operationId)!; const cfg = source(record.choreId, Number(op.payload.ruleVersion));
    if (cfg?.policy.assignment.rotation) markRotationCompletion(progress, record.choreId, cfg.rotationSourceVersion!, record.anchorDate);
  }
  for (const row of v2RetainedCompletions(view, at)) {
    if (!row.reports.length) continue; const cfg = source(row.choreId, row.ruleVersion);
    if (cfg?.policy.assignment.rotation) markRotationCompletion(progress, row.choreId, cfg.rotationSourceVersion!, row.anchorDate);
  }
  cache.set(key, progress); while (cache.size > 32) cache.delete(cache.keys().next().value!); return progress;
}
/** Completion-based turns use actual distinct work, never skipped or expired slots. */
export function v2RotationAssignee(view: V2HistoryView, at: SharedOperation, choreId: string, configuration: SharedChoreConfiguration, anchorDate: LocalDate): string {
  const rotation = configuration.policy.assignment.rotation; const sourceVersion = configuration.rotationSourceVersion;
  if (!rotation || !sourceVersion || !rotation.sequence.length) throw new Error('Missing rotation settings');
  let step = 0;
  if (rotation.advanceOn === 'completion') step = rotationCompletionCount(completionProgress(view, at), choreId, sourceVersion, anchorDate);
  else {
    const through = addDays(anchorDate, -1);
    for (const slice of timeline(view, at, choreId)) {
      const cfg = slice.configuration;
      if (!cfg || cfg.active === false || cfg.rotationSourceVersion !== sourceVersion) continue;
      const from = slice.from > cfg.anchorDate ? slice.from : cfg.anchorDate;
      const last = slice.through && slice.through < through ? slice.through : through;
      if (last < from) continue;
      const firstIndex = v2AnchorIndexOnOrAfter(cfg, from);
      const lastIndex = v2AnchorIndexBefore(cfg, last);
      step += Math.max(0, lastIndex - firstIndex + 1);
    }
  }
  return rotation.sequence[step % rotation.sequence.length];
}
