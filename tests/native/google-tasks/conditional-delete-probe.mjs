/**
 * Explicit real-service probe, never auto-run by npm test. The caller supplies an
 * already-authorized in-memory token; no credentials, provider bodies or user data
 * are logged or returned. Only a freshly created, nonce-named QA list is mutated.
 */
export async function probeConditionalTasksDelete({ api, accessToken, nonce, fetcher = fetch }) {
  if (typeof nonce !== 'string' || !/^[a-f0-9-]{32,64}$/u.test(nonce)) throw new Error('probe_nonce_required');
  const title = `LiFlow conditional-delete QA ${nonce}`;
  const evidence = { staleDeleteStatus: null, interveningCompletionPreserved: false, currentDeleteSucceeded: false, cleanupSucceeded: false };
  let listId;
  const ownList = async () => {
    const response = await fetcher(`https://tasks.googleapis.com/tasks/v1/users/@me/lists/${encodeURIComponent(listId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('probe_list_identity_unavailable');
    const value = await response.json();
    if (value.id !== listId || value.title !== title) throw new Error('probe_list_identity_changed');
  };
  try {
    const list = await api.createTaskList(accessToken, title);
    if (!list || list.title !== title || typeof list.id !== 'string' || !list.id.length || list.id.length > 1024) throw new Error('probe_list_identity_invalid');
    listId = list.id;
    const created = await api.createTask(accessToken, listId, { title: 'LiFlow synthetic concurrency probe', notes: 'Synthetic test only; no household content.' });
    if (!created || typeof created.id !== 'string' || !created.id || typeof created.etag !== 'string') throw new Error('probe_task_identity_invalid');
    const before = await api.getTask(accessToken, listId, created.id);
    await api.patchTask(accessToken, listId, created.id, { status: 'completed' });
    try { await api.deleteTask(accessToken, listId, created.id, before.etag); evidence.staleDeleteStatus = 204; }
    catch (error) { evidence.staleDeleteStatus = Number.isSafeInteger(error?.status) ? error.status : null; }
    const after = await api.getTask(accessToken, listId, created.id).catch(() => null);
    evidence.interveningCompletionPreserved = Boolean(after?.id === created.id && !after.deleted && after.status === 'completed' && after.etag !== before.etag);
    if (evidence.staleDeleteStatus === 412 && evidence.interveningCompletionPreserved) {
      await api.deleteTask(accessToken, listId, created.id, after.etag); evidence.currentDeleteSucceeded = true;
    }
  } catch { /* Failure is reported by the explicit evidence fields, never by dumping a provider error. */ }
  finally {
    if (listId) try {
      await ownList();
      const response = await fetcher(`https://tasks.googleapis.com/tasks/v1/users/@me/lists/${encodeURIComponent(listId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000),
      });
      evidence.cleanupSucceeded = response.status === 204;
    } catch { /* Leave an uncertain QA list intact. No unrelated list can be selected for cleanup. */ }
  }
  return { ...evidence, passed: evidence.staleDeleteStatus === 412 && evidence.interveningCompletionPreserved
    && evidence.currentDeleteSucceeded && evidence.cleanupSucceeded };
}
