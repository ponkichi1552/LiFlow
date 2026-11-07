import { canonicalJson } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { SharedChoreConfiguration } from './model.ts';
import type { V2HistoryView } from './history-view.ts';

const caches = new WeakMap<V2HistoryView, Map<string, ReadonlySet<number>>>();
/** Follow explicit older revisions iteratively; never fabricate new copies of signed assignment facts. */
export function v2AssignmentLineage(view: V2HistoryView, at: SharedOperation, choreId: string, configuration: SharedChoreConfiguration): ReadonlySet<number> {
  const key = canonicalJson([choreId, configuration.ruleVersion, at.context]);
  let cache = caches.get(view); if (!cache) { cache = new Map(); caches.set(view, cache); }
  const known = cache.get(key); if (known) return known;
  const versions = new Set<number>(); let cfg = configuration;
  for (;;) {
    if (versions.has(cfg.ruleVersion)) throw new Error('Cyclic assignment source'); versions.add(cfg.ruleVersion);
    if (!cfg.assignmentSourceVersion) break;
    if (cfg.assignmentSourceVersion >= cfg.ruleVersion) throw new Error('Invalid assignment source revision');
    const previous = view.configurationVersion(choreId, cfg.assignmentSourceVersion, at)?.value as unknown as SharedChoreConfiguration | undefined;
    if (!previous || canonicalJson(previous.policy) !== canonicalJson(cfg.policy)) throw new Error('Confirm the inherited assignment policy');
    cfg = previous;
  }
  cache.set(key, versions); while (cache.size > 256) cache.delete(cache.keys().next().value!); return versions;
}
