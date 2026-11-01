import { setTimeout as wait } from 'node:timers/promises';

/** Retry only the idempotent terminal write; never rerun paid analysis or extend its reservation. */
export async function persistAnalysisResult(store, admission, result) {
  for (let attempt = 0; ; attempt++) {
    try { await store.finish(admission, result); return; }
    catch (error) {
      const code = String(error?.code ?? '').replace(/^firestore\//u, '');
      const transient = ['4', '8', '10', '13', '14', 'deadline-exceeded', 'resource-exhausted', 'aborted', 'internal', 'unavailable'].includes(code);
      const delay = 100 * 2 ** attempt;
      if (!transient || attempt >= 3 || Date.now() + delay >= admission.deadlineAt) throw error;
      await wait(delay);
    }
  }
}
