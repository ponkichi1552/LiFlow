import { createFirebasePublicRuntime } from './firebase-public-runtime.mjs';
import { createPublicAnalysisDependencies } from './public-analysis.mjs';
import { runAnalysisQueueBatch } from './analysis-queue-worker.mjs';

// A scheduler must invoke this separate job within the admission deadline. The
// API intentionally does not start it or rely on post-response CPU allocation.
const controller = new AbortController();
process.env.NODE_ENV = 'production';
process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
try {
  const runtime = createFirebasePublicRuntime();
  if (!runtime.securityReady || !runtime.analysisQueueReady || !runtime.subscriptions) throw new Error('Public AI security is not ready');
  await runtime.store.ready();
  const result = await runAnalysisQueueBatch({ store: runtime.store, authorize: runtime.authorizeQueuedAnalysis,
    createDependencies: createPublicAnalysisDependencies, signal: controller.signal });
  await runtime.store.prune();
  process.stdout.write(JSON.stringify({ event: 'analysis_worker_batch', ...result }) + '\n');
  if (result.failed) process.exitCode = 1;
} catch {
  process.stderr.write(JSON.stringify({ event: 'analysis_worker_startup_refused' }) + '\n');
  process.exitCode = 1;
}
