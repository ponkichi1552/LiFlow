import { analyzeUploadedManual } from './uploaded-manual.mjs';
import { persistAnalysisResult } from './persist-result.mjs';

const failed = { status: 'error', code: 'ANALYSIS_FAILED', message: '解析を完了できませんでした。受付状況から結果を確認してください。' };
const report = value => process.stderr.write(JSON.stringify(value) + '\n');

/** Run as a scheduled job, never as unawaited work after an HTTP response.
 * Claiming is at-most-once for paid execution. Only durable result settlement
 * can be retried/taken over. No user text or upstream error is ever logged.
 */
export async function runAnalysisQueueBatch({ store, createDependencies, authorize, analyze = analyzeUploadedManual, limit = 3,
  now = Date.now, monitor = report, signal, checkpoint = async () => {} }) {
  if (typeof authorize !== 'function') throw new Error('Worker authorization is required');
  await store.heartbeatAnalysisWorker();
  const heartbeat = setInterval(() => { void store.heartbeatAnalysisWorker().catch(() => {
    monitor({ event: 'analysis_worker_persistence_failed', stage: 'heartbeat' });
  }); }, 30_000); heartbeat.unref();
  try {
    const ids = await store.listAnalysisWork(limit);
    const outcomes = await Promise.all(ids.map(async jobId => {
    let phase = 'claim'; let timeout; let abort;
    try {
      if (signal?.aborted) return 'deferred';
      const claim = await store.claimAnalysis(jobId);
      if (!claim) return 'deferred';
      const { admission } = claim;
      let result = claim.result;
      if (!result) {
        phase = 'claimed'; await checkpoint(phase, jobId);
        phase = 'input'; const request = await store.readAnalysisInput(claim);
        if (signal?.aborted || now() >= admission.deadlineAt) return 'deferred';
        else {
          phase = 'authorization'; await authorize(claim.owner, claim.createdAt);
          if (signal?.aborted) return 'deferred';
          const controller = new AbortController(); abort = () => controller.abort();
          signal?.addEventListener('abort', abort, { once: true });
          timeout = setTimeout(abort, Math.max(1, admission.deadlineAt - now())); timeout.unref();
          let progress = Promise.resolve();
          phase = 'start'; if (!await store.startAnalysis(admission)) return 'deferred';
          phase = 'analysisStarted'; await checkpoint(phase, jobId);
          phase = 'analysis';
          try { result = await analyze(request, createDependencies(controller.signal), stage => {
            progress = progress.then(() => store.progress(admission, stage)).catch(() => {
              monitor({ event: 'analysis_worker_persistence_failed', jobId, stage: 'progress' });
            });
          }); } catch { result = failed; }
          phase = 'providerReturned'; await checkpoint(phase, jobId);
          await progress;
        }
        phase = 'resultStaging';
        if (!await store.stageAnalysisResult(admission, result)) throw new Error('Analysis settlement rejected');
        phase = 'resultStaged'; await checkpoint(phase, jobId);
      }
      phase = 'settlement';
      await persistAnalysisResult(store, admission, result);
      return 'settled';
    } catch {
      monitor({ event: 'analysis_worker_failed', jobId, stage: phase });
      return 'failed';
    } finally { clearTimeout(timeout); if (abort) signal?.removeEventListener('abort', abort); }
    }));
    return { attempted: outcomes.length, settled: outcomes.filter(value => value === 'settled').length,
      failed: outcomes.filter(value => value === 'failed').length, deferred: outcomes.filter(value => value === 'deferred').length };
  } finally { clearInterval(heartbeat); }
}
