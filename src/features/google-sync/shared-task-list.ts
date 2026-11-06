import { GoogleTasksApiError } from '../../platform/google-tasks/google-tasks-api.ts';
import type { GoogleTaskList } from '../../platform/google-tasks/google-tasks-api';
import type { GoogleTaskListResolution } from './reconcile-google-tasks';
import type { GoogleSyncState } from './contracts';
import type { GoogleOperationBudget } from './operation-budget';
import { withinGoogleOperationBudget } from './operation-budget.ts';
import type { SharedTaskClaimCloud, SharedTaskClaimReader } from './shared-task-claim';
import { sharedTaskIdHash } from './shared-task-claim.ts';
import { sharedGoogleOccurrenceNote } from './workspace-policy.ts';
import { googleTaskRequestWasNotSent, isDefinitiveGoogleTaskInsertRejection } from './task-create-intent.ts';

/** Disjoint from provider list IDs. The receipt uploads only hashes, as for task inserts. */
export function sharedTaskListIdentity(namespace: string, accountSubject: string) {
  return { accountSubject, taskListId: 'reserved:shared-task-list:v1',
    occurrenceMarker: sharedGoogleOccurrenceNote(namespace, 'task-list-v1') };
}

/** Confirm the existing destination without listing unrelated Google lists or creating anything. */
export async function verifySharedTaskListForLocalChanges(state: GoogleSyncState, input: {
  namespace: string; cloud(): SharedTaskClaimReader;
  context: { budget: GoogleOperationBudget; assertCurrent(): Promise<void> };
}): Promise<boolean> {
  if (!state.accountSubject || !state.taskListId) return false;
  const { budget, assertCurrent } = input.context;
  await assertCurrent();
  const claim = await withinGoogleOperationBudget(budget, () => input.cloud().read(sharedTaskListIdentity(input.namespace, state.accountSubject!)));
  await assertCurrent();
  return claim?.phase === 'linked' && claim.taskHash === sharedTaskIdHash(state.taskListId);
}

/** One list-creation grant across independent device databases, before task creation. */
export async function resolveSharedGoogleTaskList(request: GoogleTaskListResolution, input: {
  namespace: string; cloud(): SharedTaskClaimCloud & SharedTaskClaimReader; makeId(): string;
  context: { budget: GoogleOperationBudget; assertCurrent(): Promise<void> };
}): Promise<GoogleTaskList> {
  const { state, accessToken, api, title } = request;
  if (!state.accountSubject) throw new Error('Google家事を送信するアカウントを確認してください。');
  const identity = sharedTaskListIdentity(input.namespace, state.accountSubject);
  const { budget, assertCurrent } = input.context;
  const bounded = <T>(work: () => Promise<T>) => withinGoogleOperationBudget(budget, async () => {
    await assertCurrent(); const value = await work(); await assertCurrent(); return value;
  });
  const cloud = input.cloud();
  let lists = request.lists;
  const candidate = () => {
    const saved = lists.find(row => row.id === state.taskListId);
    if (saved) return saved;
    const matching = lists.filter(row => row.title === title);
    if (matching.length > 1) throw new GoogleTasksApiError(409, 'ambiguous_task_list', null);
    return matching[0];
  };
  const ready = (taskHash: string | null) => {
    const matches = lists.filter(row => sharedTaskIdHash(row.id) === taskHash);
    if (matches.length > 1) throw new GoogleTasksApiError(409, 'ambiguous_task_list', null);
    const selected = matches[0];
    // An old client may already have another list with private mappings. Do not
    // silently transfer or delete its tasks while resolving the new canonical ID.
    if (selected && state.taskListId && selected.id !== state.taskListId && lists.some(row => row.id === state.taskListId)) {
      throw new GoogleTasksApiError(409, 'ambiguous_task_list', null);
    }
    return selected;
  };
  let claim = await bounded(() => cloud.read(identity));
  if (claim?.phase === 'linked') {
    const selected = ready(claim.taskHash); if (selected) return selected;
    // A fresh, complete provider listing can prove deletion only when this
    // device retained the exact previous ID. A reinstall is not such evidence.
    if (!state.taskListId || sharedTaskIdHash(state.taskListId) !== claim.taskHash) {
      throw new GoogleTasksApiError(503, 'task_list_create_result_pending', null);
    }
    await bounded(() => cloud.deleted(identity, state.taskListId!));
    claim = await bounded(() => cloud.read(identity));
  }
  if (!claim || claim.phase === 'released') {
    const existing = candidate();
    if (existing) { await bounded(() => cloud.linked(identity, existing.id)); return existing; }
    const intent = { ...identity, attemptId: input.makeId(), startedAt: new Date().toISOString() };
    const accepted = await bounded(() => cloud.reserveBatch([intent]));
    if (accepted.length !== 1 || typeof accepted[0] !== 'boolean') throw new Error('Google家事の保存先の作成許可を確認してください。');
    if (accepted[0]) {
      let issued = false;
      try {
        // The original listing may predate the grant. Recheck before the only POST.
        lists = await bounded(() => api.listTaskLists(accessToken));
        let selected = candidate();
        if (!selected) {
          await assertCurrent(); budget.assert();
          issued = true;
          selected = await api.createTaskList(accessToken, title);
          await assertCurrent(); budget.assert();
          if (!selected.id) throw new GoogleTasksApiError(502, 'missing_task_list_id', null);
        }
        await bounded(() => cloud.linked(identity, selected.id)); return selected;
      } catch (error) {
        if (!issued || googleTaskRequestWasNotSent(error) || error instanceof GoogleTasksApiError && isDefinitiveGoogleTaskInsertRejection(error.status)) {
          await bounded(() => cloud.reject(intent));
        }
        throw error;
      }
    }
  }
  // Another device is finishing its insert. A reservation never expires into
  // permission for a second POST, including after an uncertain provider reply.
  for (const delay of [0, 100, 250]) {
    if (delay) await bounded(() => new Promise<void>(resolve => setTimeout(resolve, delay)));
    claim = await bounded(() => cloud.read(identity));
    if (claim?.phase !== 'linked') continue;
    lists = await bounded(() => api.listTaskLists(accessToken));
    const selected = ready(claim.taskHash); if (selected) return selected;
  }
  throw new GoogleTasksApiError(503, 'task_list_create_result_pending', null);
}
