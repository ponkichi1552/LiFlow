import { setTimeout as wait } from 'node:timers/promises';

/** Retry only the idempotent terminal write; never rerun paid analysis or extend its reservation. */
export async function persistAnalysisResult(store, admission, result) {
  await retryAnalysisWrite(() => store.finish(admission, result), admission.deadlineAt);
}

export async function retryAnalysisWrite(write, until, now = Date.now) {
  for (let attempt = 0; ; attempt++) {
    try { return await write(); }
    catch (error) {
      const code = String(error?.code ?? '').replace(/^firestore\//u, '');
      const transient = ['4', '8', '10', '13', '14', 'deadline-exceeded', 'resource-exhausted', 'aborted', 'internal', 'unavailable'].includes(code);
      const delay = 100 * 2 ** attempt;
      if (!transient || attempt >= 3 || now() + delay >= until) throw error;
      await wait(delay);
    }
  }
}
