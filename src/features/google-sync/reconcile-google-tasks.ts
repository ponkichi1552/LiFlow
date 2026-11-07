import type { GoogleSyncEntry, GoogleSyncState, GoogleTaskStatusChange, GoogleTaskLink, GoogleTaskStatus } from './contracts';
import { parseGoogleCompletedAt } from './google-completion-policy';
import { GOOGLE_TASKS_BATCH_MAX_REQUESTS, GOOGLE_TASKS_LIST_TITLE, GoogleTaskNotFoundError, GoogleTasksApiError, isGoogleTaskETag } from '@/platform/google-tasks/google-tasks-api';
import type { GoogleTask, GoogleTaskList, GoogleTaskPatch, GoogleTasksApi, GoogleTasksBatchItemResult } from '@/platform/google-tasks/google-tasks-api';
import { addDays } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import { personalGoogleOccurrenceNote, sharedGoogleListTitle, sharedGoogleOccurrenceNote } from './workspace-policy';
import { isDefinitiveGoogleTaskInsertRejection, googleTaskRequestWasNotSent } from './task-create-intent.ts';
import type { GoogleTaskCreateIntent, GoogleTaskCreateJournal, GoogleTaskCreateResult } from './task-create-intent';
import { GoogleTaskFullSyncRequiredError, readGoogleTasksCheckpointed } from './task-read-cache.ts';
import type { GoogleTaskReadCache } from './task-read-cache';
import { googleTaskBatchFailure } from './batch-failure.ts';

/** Keep the Google list useful by synchronizing a rolling two-week planner window. */
export const GOOGLE_TASK_SYNC_WINDOW_DAYS = 14;

function occurrenceNote(notes: string | undefined, shared: boolean): string | undefined {
  const pattern = shared ? /^LiFlow occurrence: [a-f0-9]{64}$/u : /^LiFlow personal occurrence: [a-f0-9]{64}$/u;
  const markers = new Set(notes?.split(/\r?\n/u).filter(line => pattern.test(line)) ?? []);
  return markers.size === 1 ? [...markers][0] : undefined;
}
function appendOccurrenceNote(notes: string | undefined, marker: string): string | undefined {
  if (notes?.split(/\r?\n/u).includes(marker)) return undefined;
  const value = [notes, marker].filter(Boolean).join('\n\n');
  // A provider-side user note is never truncated to make room for metadata.
  return value.length <= 8192 ? value : undefined;
}

export interface GoogleTaskListResolution {
  state: GoogleSyncState;
  accessToken: string;
  api: GoogleTasksApi;
  lists: readonly GoogleTaskList[];
  title: string;
}
export interface GoogleSyncRepositoryPort {
  /** Shared workspaces use a separate private list and exact stable occurrence markers. */
  taskNamespace?: string;
  /** Native adapters persist before every non-idempotent insert. Legacy injected ports may omit this capability. */
  taskCreateJournal?: GoogleTaskCreateJournal;
  taskReadCache?: GoogleTaskReadCache;
  /** Shared native clients arbitrate the list itself before any per-task grant. */
  resolveTaskList?(input: GoogleTaskListResolution): Promise<GoogleTaskList>;
  /** One coherent local view for an existing-ID status push, without a remote inventory scan. */
  readLocalStatusSnapshot?(today: string, householdId: string): Promise<{ entries: GoogleSyncEntry[]; links: GoogleTaskLink[] }>;
  /** Shared clients still verify the current account's canonical list claim. Never creates a list. */
  verifyTaskListForLocalChanges?(state: GoogleSyncState): Promise<boolean>;
  listEntriesForGoogleSync(today: string, householdId: string): Promise<GoogleSyncEntry[]>;
  listGoogleTaskLinks(householdId: string): Promise<GoogleTaskLink[]>;
  upsertGoogleTaskLink(link: GoogleTaskLink): Promise<void>;
  deleteGoogleTaskLink(scheduleEntryId: string): Promise<void>;
  importGoogleTaskChanges(changes: readonly GoogleTaskStatusChange[], today: string): Promise<number>;
  acknowledgeGoogleTaskStatus(link: GoogleTaskLink, status: GoogleTaskStatus): Promise<void>;
  acknowledgeGoogleTaskStatuses?(changes: readonly { link: GoogleTaskLink; status: GoogleTaskStatus }[]): Promise<void>;
}

export interface GoogleReconciliationResult {
  taskListId: string;
  created: number;
  updated: number;
  removed: number;
  imported: number;
  remoteTasksRead: number;
  hiddenCompletionsRead: number;
  invalidCompletions: number;
}

/** A recent reconciliation permits a narrow push of already mapped local intentions.
 * New/moved/renamed/deleted/uncertain items require the normal reconciliation.
 * A status-only push never advances the remote-pull checkpoint. */
export async function reconcileLocalGoogleTaskStatuses(options: {
  accessToken: string; state: GoogleSyncState; repository: GoogleSyncRepositoryPort; api: GoogleTasksApi; today: LocalDate;
}): Promise<GoogleReconciliationResult | null> {
  const { accessToken, state, repository, api, today } = options;
  if (!state.taskListId || !repository.readLocalStatusSnapshot || !repository.verifyTaskListForLocalChanges) return null;
  const { entries, links } = await repository.readLocalStatusSnapshot(today, state.householdId);
  const linked = new Map(links.map(link => [link.scheduleEntryId, link]));
  if (linked.size !== links.length || new Set(links.map(link => link.googleTaskId)).size !== links.length) return null;
  const entryIds = new Set(entries.map(item => item.entry.id));
  if (links.some(link => link.googleTaskListId !== state.taskListId || !entryIds.has(link.scheduleEntryId))) return null;
  const changes: { item: GoogleSyncEntry; link: GoogleTaskLink; patch: GoogleTaskPatch }[] = [];
  const through = addDays(today, GOOGLE_TASK_SYNC_WINDOW_DAYS);
  for (const item of entries) {
    const link = linked.get(item.entry.id);
    if (item.synchronizationBlocked || !link && item.entry.suggestedDate <= through) return null;
    if (!link) continue;
    if (link.lastSyncedTitle !== item.choreName || link.lastSyncedDueDate !== item.entry.suggestedDate) return null;
    const desired = item.completedAt ? 'completed' : 'needsAction';
    if (!link.pendingStatus) { if (link.lastSyncedStatus !== desired) return null; continue; }
    if (!item.localRevision || link.pendingStatusRevision !== item.localRevision || link.observedLocalRevision !== item.localRevision
      || link.pendingStatus !== desired || desired === 'completed' && !parseGoogleCompletedAt(item.completedAt)) return null;
    changes.push({ item, link, patch: { status: desired, completed: desired === 'completed' ? item.completedAt : null } });
  }
  if (!changes.length || !await repository.verifyTaskListForLocalChanges(state)) return null;
  let updated = 0;
  for (let offset = 0; offset < changes.length; offset += GOOGLE_TASKS_BATCH_MAX_REQUESTS) {
    const chunk = changes.slice(offset, offset + GOOGLE_TASKS_BATCH_MAX_REQUESTS);
    const results = api.patchTasksBatch
      ? await api.patchTasksBatch(accessToken, state.taskListId, chunk.map(({ link, patch }) => ({ taskId: link.googleTaskId, patch })))
      : await runTaskRequestsSequentially(chunk, ({ link, patch }) => api.patchTask(accessToken, state.taskListId!, link.googleTaskId, patch));
    let failure = googleTaskBatchFailure(results);
    const confirmed = results.flatMap((result, index) => result.ok && chunk[index]
      && result.task.id === chunk[index].link.googleTaskId && !result.task.deleted && result.task.status === chunk[index].patch.status ? [result.task] : []);
    if (confirmed.length) await repository.taskReadCache?.written?.({ accountSubject: state.accountSubject ?? state.householdId, taskListId: state.taskListId }, confirmed);
    const acknowledgements: { link: GoogleTaskLink; status: GoogleTaskStatus }[] = [];
    for (const [index, candidate] of chunk.entries()) {
      const result = results[index];
      if (!result || !result.ok) {
        failure ??= result && !result.ok ? new GoogleTasksApiError(result.status, result.code, result.retryAfter ?? null)
          : new GoogleTasksApiError(502, 'missing_batch_response', null);
        continue;
      }
      if (result.task.id !== candidate.link.googleTaskId || result.task.deleted || result.task.status !== candidate.patch.status) {
        failure ??= new GoogleTasksApiError(502, 'mismatched_batch_task_status', null); continue;
      }
      acknowledgements.push({ link: candidate.link, status: candidate.patch.status! });
    }
    if (acknowledgements.length) {
      if (repository.acknowledgeGoogleTaskStatuses) await repository.acknowledgeGoogleTaskStatuses(acknowledgements);
      else for (const acknowledgement of acknowledgements) await repository.acknowledgeGoogleTaskStatus(acknowledgement.link, acknowledgement.status);
      updated += acknowledgements.length;
    }
    if (failure?.status === 404) throw new GoogleTaskFullSyncRequiredError();
    if (failure) throw failure;
  }
  return { taskListId: state.taskListId, created: 0, updated, removed: 0, imported: 0,
    remoteTasksRead: 0, hiddenCompletionsRead: 0, invalidCompletions: 0 };
}

export async function reconcileGoogleTasks(options: {
  accessToken: string;
  state: GoogleSyncState;
  repository: GoogleSyncRepositoryPort;
  api: GoogleTasksApi;
  now: Date;
  today: LocalDate;
  deltaOnly?: boolean;
}): Promise<GoogleReconciliationResult> {
  const { accessToken, repository, api, now, today } = options;
  const { state } = options;
  const namespace = repository.taskNamespace;
  const marker = (entryId: string) => namespace ? sharedGoogleOccurrenceNote(namespace, entryId)
    : personalGoogleOccurrenceNote(state.accountSubject ?? state.householdId, state.householdId, entryId);
  const listTitle = namespace ? sharedGoogleListTitle(namespace) : GOOGLE_TASKS_LIST_TITLE;
  const syncThrough = addDays(today, GOOGLE_TASK_SYNC_WINDOW_DAYS);
  const isInSyncWindow = (item: GoogleSyncEntry) => item.entry.suggestedDate <= syncThrough;
  if (options.deltaOnly && (!state.taskListId || !repository.taskReadCache || !await repository.verifyTaskListForLocalChanges?.(state))) {
    throw new GoogleTaskFullSyncRequiredError();
  }
  const taskLists = options.deltaOnly ? [] : await api.listTaskLists(accessToken);
  const taskList = options.deltaOnly ? { id: state.taskListId!, title: listTitle } : repository.resolveTaskList
    ? await repository.resolveTaskList({ state, accessToken, api, lists: taskLists, title: listTitle })
    : taskLists.find((candidate) => candidate.id === state.taskListId)
    ?? taskLists.find((candidate) => candidate.title === listTitle)
    ?? await api.createTaskList(accessToken, listTitle);
  if (!taskList.id) throw new Error('Google Tasks did not return a task list ID');
  const createIdentity = (entryId: string) => ({ accountSubject: state.accountSubject ?? state.householdId,
    taskListId: taskList.id, occurrenceMarker: marker(entryId) });
  const rejectReservations = async (intents: readonly GoogleTaskCreateIntent[]) => {
    const journal = repository.taskCreateJournal; if (!journal || !intents.length) return;
    if (journal.rejectBatch) await journal.rejectBatch(intents); else for (const intent of intents) await journal.reject(intent);
  };
  const recoverResults = async () => {
    const journal = repository.taskCreateJournal;
    if (!journal?.pending) return;
    for (;;) {
      const pending = await journal.pending({ accountSubject: state.accountSubject ?? state.householdId, taskListId: taskList.id });
      if (!pending.length) return;
      let failure: unknown;
      const rejected = pending.filter(result => result.kind === 'rejected');
      if (rejected.length) try {
        await rejectReservations(rejected.map(result => result.intent)); await journal.settled?.(rejected);
      } catch (error) { failure = error; }
      const acknowledged: GoogleTaskCreateResult[] = [];
      for (const result of pending) if (result.kind === 'created') try {
        await journal.linked(result.intent, result.taskId, result.intent); acknowledged.push(result);
      } catch (error) { failure ??= error; }
      if (acknowledged.length) try { await journal.settled?.(acknowledged); } catch (error) { failure ??= error; }
      if (failure) throw failure;
      if (!journal.settled) return;
    }
  };
  await recoverResults();

  let remoteTasksRead = 0; let hiddenCompletionsRead = 0;
  const observePage = (tasks: readonly GoogleTask[]) => {
    remoteTasksRead += tasks.length; hiddenCompletionsRead += tasks.filter(task => task.hidden && !task.deleted && task.status === 'completed').length;
  };
  const remoteTasks = repository.taskReadCache ? await readGoogleTasksCheckpointed({ api, cache: repository.taskReadCache,
    scope: { accountSubject: state.accountSubject ?? state.householdId, taskListId: taskList.id }, accessToken, now, deltaOnly: options.deltaOnly, onPage: observePage })
    : await api.listTasks(accessToken, taskList.id);
  if (!repository.taskReadCache) observePage(remoteTasks);
  const tasksById = new Map(remoteTasks.map((task) => [task.id, task]));
  const local = repository.readLocalStatusSnapshot ? await repository.readLocalStatusSnapshot(today, state.householdId)
    : { entries: await repository.listEntriesForGoogleSync(today, state.householdId), links: await repository.listGoogleTaskLinks(state.householdId) };
  let links = local.links;
  const beforeEntries = new Map(local.entries.map(item => [item.entry.id, item]));

  // A local reinstall/reset can remove SQLite links while the app-created Google tasks remain.
  // Only immutable account/workspace/round identity can adopt a task. Names and
  // due dates are mutable, and an unrelated manual task can have the same pair.
  const usedTaskIds = new Set(links.filter((link) => link.googleTaskListId === taskList.id).map((link) => link.googleTaskId));
  const linkedScheduleEntryIds = new Set(links.map((link) => link.scheduleEntryId));
  const tasksByOccurrence = new Map<string, GoogleTask[]>();
  for (const task of remoteTasks) {
    if (task.deleted || (task.status !== 'completed' && task.status !== 'needsAction')) continue;
    const key = occurrenceNote(task.notes, Boolean(namespace));
    if (!key) continue;
    tasksByOccurrence.set(key, [...(tasksByOccurrence.get(key) ?? []), task]);
  }
  for (const item of beforeEntries.values()) {
    if (item.synchronizationBlocked || !isInSyncWindow(item) || linkedScheduleEntryIds.has(item.entry.id)) continue;
    const candidates = (tasksByOccurrence.get(marker(item.entry.id)) ?? []).filter(task => !usedTaskIds.has(task.id));
    if (candidates.length > 1) throw new GoogleTasksApiError(409, 'ambiguous_task_occurrence', null);
    let existingTask = candidates[0];
    if (!existingTask) continue;
    if (namespace && repository.taskCreateJournal) {
      try { existingTask = await api.getTask(accessToken, taskList.id, existingTask.id); }
      catch (error) { if (error instanceof GoogleTaskNotFoundError) continue; throw error; }
      if (existingTask.deleted || occurrenceNote(existingTask.notes, true) !== marker(item.entry.id)) continue;
      tasksById.set(existingTask.id, existingTask);
    }
    const adoptedLink = {
      scheduleEntryId: item.entry.id,
      householdId: state.householdId,
      choreId: item.entry.choreId,
      googleTaskListId: taskList.id,
      googleTaskId: existingTask.id,
      lastSyncedTitle: item.choreName,
      lastSyncedDueDate: item.entry.suggestedDate,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...(item.localRevision ? { observedLocalRevision: item.localRevision } : {}),
    };
    await repository.taskCreateJournal?.linked(createIdentity(item.entry.id), existingTask.id);
    await repository.upsertGoogleTaskLink(adoptedLink);
    links = [...links, adoptedLink];
    usedTaskIds.add(existingTask.id);
    linkedScheduleEntryIds.add(item.entry.id);
  }

  const changes: GoogleTaskStatusChange[] = [];
  let invalidCompletions = 0;
  for (const link of links) {
    if (link.googleTaskListId !== taskList.id) continue;
    const task = tasksById.get(link.googleTaskId);
    if (!task || task.deleted || (task.status !== 'completed' && task.status !== 'needsAction')) continue;
    const local = beforeEntries.get(link.scheduleEntryId);
    if (local?.synchronizationBlocked) continue;
    const localStatus = local?.completedAt ? 'completed' : 'needsAction';
    const locallyChanged = link.pendingStatus
      || (local && link.lastSyncedStatus && localStatus !== link.lastSyncedStatus)
      || (local?.locallyIncomplete && !link.lastSyncedStatus);
    if (locallyChanged) continue;
    if (task.status === 'needsAction') {
      if (link.lastSyncedStatus === 'completed' && local?.completedAt) {
        changes.push({ googleTaskListId: taskList.id, googleTaskId: task.id,
          scheduleEntryId: link.scheduleEntryId, status: 'needsAction' });
      }
      continue;
    }
    if (link.lastSyncedStatus === 'completed' && local?.completedAt) continue;
    const completedAt = parseGoogleCompletedAt(task.completed);
    if (!completedAt) {
      invalidCompletions += 1;
      continue;
    }
    changes.push({
      googleTaskListId: taskList.id,
      googleTaskId: task.id,
      scheduleEntryId: link.scheduleEntryId,
      completedAt,
      status: 'completed',
    });
  }
  // Pull actual remote state changes in one transaction before writing to Google.
  let imported = changes.length ? await repository.importGoogleTaskChanges(changes, today) : 0;
  const after = imported ? repository.readLocalStatusSnapshot ? await repository.readLocalStatusSnapshot(today, state.householdId)
    : { entries: await repository.listEntriesForGoogleSync(today, state.householdId), links: await repository.listGoogleTaskLinks(state.householdId) }
    : { entries: local.entries, links };
  const entries = after.entries;
  const linksById = new Map(after.links.map(link => [link.scheduleEntryId, link]));
  const entriesById = new Map(entries.map(({ entry }) => [entry.id, entry]));
  let created = 0;
  let updated = 0;
  let removed = 0;
  const createCandidates: GoogleSyncEntry[] = [];
  type PendingPatch = { item: GoogleSyncEntry; task: GoogleTask; link: GoogleTaskLink; patch: GoogleTaskPatch };
  const pendingPatches: PendingPatch[] = [];
  const persistSyncedEntry = async (item: GoogleSyncEntry, originalLink: GoogleTaskLink, status: GoogleTaskStatus) => {
    let link = { ...originalLink, ...(item.localRevision ? { observedLocalRevision: item.localRevision } : {}) };
    if (link.lastSyncedTitle !== item.choreName || link.lastSyncedDueDate !== item.entry.suggestedDate) {
      link = { ...link, lastSyncedTitle: item.choreName, lastSyncedDueDate: item.entry.suggestedDate, updatedAt: now.toISOString() };
      await repository.upsertGoogleTaskLink(link);
      linksById.set(item.entry.id, link);
    }
    // A title/due PATCH can incidentally observe a concurrent Google undo. It
    // is not an acknowledgement of that status until the normal import runs.
    if (status === (item.completedAt ? 'completed' : 'needsAction') && (link.lastSyncedStatus !== status || link.pendingStatus)) {
      await repository.acknowledgeGoogleTaskStatus(link, status);
    }
  };
  const applyPatches = async (candidates: readonly PendingPatch[]) => {
    for (let offset = 0; offset < candidates.length; offset += GOOGLE_TASKS_BATCH_MAX_REQUESTS) {
      const chunk = candidates.slice(offset, offset + GOOGLE_TASKS_BATCH_MAX_REQUESTS);
      const results = api.patchTasksBatch
        ? await api.patchTasksBatch(accessToken, taskList.id, chunk.map(({ task, patch }) => ({ taskId: task.id, patch })))
        : await runTaskRequestsSequentially(chunk, ({ task, patch }) => api.patchTask(accessToken, taskList.id, task.id, patch));
      let firstFailure = googleTaskBatchFailure(results);
      const confirmed = results.flatMap((result, index) => result.ok && chunk[index] && result.task.id === chunk[index].task.id ? [result.task] : []);
      if (confirmed.length) await repository.taskReadCache?.written?.({ accountSubject: state.accountSubject ?? state.householdId, taskListId: taskList.id }, confirmed);
      for (const [index, candidate] of chunk.entries()) {
        const result = results[index];
        if (!result || !result.ok) {
          firstFailure ??= result && !result.ok
            ? new GoogleTasksApiError(result.status, result.code, result.retryAfter ?? null)
            : new GoogleTasksApiError(502, 'missing_batch_response', null);
          continue;
        }
        if (result.task.id !== candidate.task.id) {
          firstFailure ??= new GoogleTasksApiError(502, 'mismatched_batch_task_id', null);
          continue;
        }
        updated += 1;
        await persistSyncedEntry(candidate.item, candidate.link, result.task.status);
      }
      if (firstFailure) throw firstFailure;
    }
  };

  for (const item of entries) {
    if (item.synchronizationBlocked) continue;
    const entry = item.entry;
    const inSyncWindow = isInSyncWindow(item);
    let link = linksById.get(entry.id);
    let task: GoogleTask | null = null;
    if (link) {
      task = link.googleTaskListId === taskList.id ? tasksById.get(link.googleTaskId) ?? null : null;
      if (!task || task.deleted) {
        // Leave an out-of-window link alone; it can be repaired when the entry enters the window.
        if (!inSyncWindow) continue;
        // Keep this private deletion receipt across passes and restarts. A new
        // local completion/undo revision can explicitly re-open synchronization.
        if (item.completedAt && link.lastSyncedStatus === 'completed' && !link.pendingStatus) continue;
        if (repository.taskCreateJournal && link.googleTaskListId === taskList.id && !task) {
          try { task = await api.getTask(accessToken, link.googleTaskListId, link.googleTaskId); }
          catch (error) { if (!(error instanceof GoogleTaskNotFoundError)) throw error; }
        }
      }
      if (!task || task.deleted) {
        if (repository.taskCreateJournal && link.googleTaskListId === taskList.id) await repository.taskCreateJournal.deleted(createIdentity(entry.id), link.googleTaskId);
        await repository.deleteGoogleTaskLink(link.scheduleEntryId);
        linksById.delete(link.scheduleEntryId);
        link = undefined;
        task = null;
        // A remote deletion never removes local history or recreates deleted history.
        if (item.completedAt) continue;
      }
    }

    // The two-week limit only controls new tasks. A linked task must keep its current
    // due date even when Calendar moves the occurrence beyond the creation window.
    if (!inSyncWindow && (!task || !link)) continue;

    if (!task || !link) {
      createCandidates.push(item);
      continue;
    }

    if (task.status !== 'completed' && task.status !== 'needsAction') continue;
    const localStatus = item.completedAt ? 'completed' : 'needsAction';
    const desiredStatus = link.pendingStatus ?? localStatus;
    const pushLocalStatus = Boolean(link.pendingStatus || (link.lastSyncedStatus && localStatus !== link.lastSyncedStatus)
      || (!link.lastSyncedStatus && item.locallyIncomplete));
    // A completion may have committed just after the entry read. Its queued follow-up has the exact timestamp.
    if (desiredStatus === 'completed' && !item.completedAt) continue;
    const patch: GoogleTaskPatch = {};
    const appendedNote = appendOccurrenceNote(task.notes, marker(entry.id));
    if (namespace && appendedNote !== undefined) patch.notes = appendedNote;
    if (task.title !== item.choreName) patch.title = item.choreName;
    if (googleDueLocalDate(task.due) !== entry.suggestedDate) patch.due = googleDueDate(entry.suggestedDate);
    if (desiredStatus === 'completed' && task.status !== 'completed') {
      patch.status = 'completed';
      patch.completed = item.completedAt;
    } else if (desiredStatus === 'needsAction' && task.status === 'completed' && pushLocalStatus) {
      patch.status = 'needsAction';
      patch.completed = null;
    }
    // Upgrade mapped legacy tasks alongside a real change instead of spending
    // hundreds of requests only to decorate old notes.
    if (!namespace && Object.keys(patch).length && appendedNote !== undefined) patch.notes = appendedNote;
    if (Object.keys(patch).length > 0) {
      pendingPatches.push({ item, task, link, patch });
    } else await persistSyncedEntry(item, link, task.status);
  }
  await applyPatches(pendingPatches);

  const newlyCreated: { item: GoogleSyncEntry; task: GoogleTask; link: GoogleTaskLink }[] = [];
  let unresolvedCreate = false;
  for (let offset = 0; offset < createCandidates.length; offset += GOOGLE_TASKS_BATCH_MAX_REQUESTS) {
    const reserved: { item: GoogleSyncEntry; intent?: GoogleTaskCreateIntent }[] = [];
    try {
      const items = createCandidates.slice(offset, offset + GOOGLE_TASKS_BATCH_MAX_REQUESTS);
      const batch = repository.taskCreateJournal?.reserveBatch
        ? await repository.taskCreateJournal.reserveBatch(items.map(item => createIdentity(item.entry.id))) : undefined;
      if (repository.taskCreateJournal?.reserveBatch && (!Array.isArray(batch) || batch.length !== items.length
        || batch.some(value => value === undefined))) throw new Error('Google家事の作成記録の件数が異なります。');
      for (const [index, item] of items.entries()) {
        const identity = createIdentity(item.entry.id);
        const intent = batch ? batch[index] : await repository.taskCreateJournal?.reserve(identity);
        if (intent === null) { unresolvedCreate = true; continue; }
        if (intent && (intent.accountSubject !== identity.accountSubject || intent.taskListId !== identity.taskListId
          || intent.occurrenceMarker !== identity.occurrenceMarker || !intent.attemptId || !Number.isFinite(Date.parse(intent.startedAt)))) throw new Error('Google家事の作成記録が別の家事を指しています。');
        reserved.push({ item, ...(intent ? { intent } : {}) });
      }
    } catch (error) {
      // No request for this chunk has started. Do not strand its earlier reservations if a later SQLite reservation fails.
      await rejectReservations(reserved.flatMap(row => row.intent ? [row.intent] : []));
      throw error;
    }
    const chunk = reserved.map(row => row.item);
    if (!chunk.length) continue;
    const drafts = chunk.map((item) => ({
      title: item.choreName,
      due: googleDueDate(item.entry.suggestedDate),
      notes: marker(item.entry.id),
    }));
    let results: GoogleTasksBatchItemResult[];
    try {
      results = api.createTasksBatch
        ? await api.createTasksBatch(accessToken, taskList.id, drafts)
        : await runTaskRequestsSequentially(drafts, (draft) => api.createTask(accessToken, taskList.id, draft));
    } catch (error) {
      if (googleTaskRequestWasNotSent(error) || error instanceof GoogleTasksApiError && isDefinitiveGoogleTaskInsertRejection(error.status)) {
        await rejectReservations(reserved.flatMap(row => row.intent ? [row.intent] : []));
      }
      throw error;
    }
    const responseFailure = googleTaskBatchFailure(results);
    const received: GoogleTaskCreateResult[] = reserved.flatMap((row, index): GoogleTaskCreateResult[] => {
      const result = results[index]; if (!row.intent || !result) return [];
      if (result.ok && typeof result.task.id === 'string' && result.task.id) return [{ intent: row.intent, kind: 'created' as const, taskId: result.task.id }];
      if (!result.ok && (result.requestNotSent || isDefinitiveGoogleTaskInsertRejection(result.status))) return [{ intent: row.intent, kind: 'rejected' as const }];
      return [];
    });
    if (received.length) await repository.taskCreateJournal?.received?.(received);
    const rejected = received.filter(result => result.kind === 'rejected');
    // Rejections are independent of link saves and are released together.
    await rejectReservations(rejected.map(result => result.intent));
    await repository.taskCreateJournal?.settled?.(rejected);
    let firstFailure = responseFailure;
    const acknowledged: GoogleTaskCreateResult[] = [];
    try {
      for (let index = 0; index < chunk.length; index += 1) {
        const item = chunk[index];
        const result = results[index];
        if (!item || !result || !result.ok) {
          firstFailure ??= result && !result.ok
            ? new GoogleTasksApiError(result.status, result.code, result.retryAfter ?? null)
            : new GoogleTasksApiError(502, 'missing_batch_response', null);
          continue;
        }
        const task = result.task;
        if (!task.id) {
          firstFailure ??= new GoogleTasksApiError(502, 'missing_batch_task_id', null);
          continue;
        }
        const link: GoogleTaskLink = {
          scheduleEntryId: item.entry.id,
          householdId: state.householdId,
          choreId: item.entry.choreId,
          googleTaskListId: taskList.id,
          googleTaskId: task.id,
          lastSyncedTitle: item.choreName,
          lastSyncedDueDate: item.entry.suggestedDate,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          ...(item.localRevision ? { observedLocalRevision: item.localRevision } : {}),
        };
        // Persist each successful response immediately so a later failed chunk resumes safely.
        const intent = reserved[index]?.intent;
        await repository.taskCreateJournal?.linked(createIdentity(item.entry.id), task.id, intent ?? undefined);
        await repository.upsertGoogleTaskLink(link);
        acknowledged.push(...received.filter(result => result.intent.attemptId === intent?.attemptId));
        linksById.set(item.entry.id, link);
        newlyCreated.push({ item, task, link });
        created += 1;
      }
    } finally {
      if (acknowledged.length) await repository.taskCreateJournal?.settled?.(acknowledged);
    }
    if (firstFailure) throw firstFailure;
  }

  // A batch cannot depend on a task ID returned by another request in that same batch.
  // Apply local completions to newly inserted tasks after their IDs have been persisted.
  const completionPatches: PendingPatch[] = [];
  for (const { item, task, link } of newlyCreated) {
    if (task.status !== 'completed' && task.status !== 'needsAction') continue;
    if (item.completedAt && task.status !== 'completed') {
      completionPatches.push({ item, task, link, patch: { status: 'completed', completed: item.completedAt } });
    } else await persistSyncedEntry(item, link, task.status);
  }
  await applyPatches(completionPatches);

  // Cleanup runs last, after imported completions have been preserved by the repository.
  for (const link of links) {
    if (!linksById.has(link.scheduleEntryId)) continue;
    if (entriesById.has(link.scheduleEntryId) && link.googleTaskListId === taskList.id) continue;
    const task = link.googleTaskListId === taskList.id ? tasksById.get(link.googleTaskId) ?? null : undefined;
    const cleanup = await removeObsoleteLink(accessToken, link, api, task);
    if (cleanup.kind === 'deferred') continue;
    if (cleanup.kind === 'completed' && link.lastSyncedStatus !== 'completed') {
      const completedAt = parseGoogleCompletedAt(cleanup.task.completed);
      if (!completedAt || link.pendingStatus) continue;
      const saved = await repository.importGoogleTaskChanges([{ scheduleEntryId: link.scheduleEntryId, googleTaskId: link.googleTaskId,
        googleTaskListId: link.googleTaskListId, status: 'completed', completedAt }], today);
      if (!saved) continue;
      imported += saved;
    }
    if (cleanup.kind === 'deleted') await repository.taskCreateJournal?.deleted({ ...createIdentity(link.scheduleEntryId), taskListId: link.googleTaskListId }, link.googleTaskId);
    const currentLink = linksById.get(link.scheduleEntryId);
    if (currentLink?.googleTaskListId === link.googleTaskListId && currentLink.googleTaskId === link.googleTaskId) {
      await repository.deleteGoogleTaskLink(link.scheduleEntryId);
      linksById.delete(link.scheduleEntryId);
    }
    removed += 1;
  }

  if (unresolvedCreate) throw new GoogleTasksApiError(503, 'task_create_result_pending', null);

  return {
    taskListId: taskList.id, created, updated, removed, imported,
    remoteTasksRead, hiddenCompletionsRead,
    invalidCompletions,
  };
}

async function runTaskRequestsSequentially<T>(
  items: readonly T[], request: (item: T) => Promise<GoogleTask>,
): Promise<GoogleTasksBatchItemResult[]> {
  const results: GoogleTasksBatchItemResult[] = [];
  for (const [index, item] of items.entries()) {
    try {
      results.push({ requestId: `request-${index}`, ok: true, task: await request(item) });
    } catch (error) {
      const apiError = error instanceof GoogleTasksApiError ? error : undefined;
      const missing = error instanceof GoogleTaskNotFoundError;
      results.push({ requestId: `request-${index}`, ok: false, status: apiError?.status ?? (missing ? 404 : 500), code: apiError?.code ?? (missing ? 'task_not_found' : 'task_request_failed'),
        ...(googleTaskRequestWasNotSent(error) ? { requestNotSent: true } : {}),
        ...(apiError?.retryAfter ? { retryAfter: apiError.retryAfter } : {}) });
    }
  }
  return results;
}

async function removeObsoleteLink(accessToken: string, link: GoogleTaskLink, api: GoogleTasksApi, knownTask?: GoogleTask | null): Promise<{ kind: 'deleted' | 'deferred' } | { kind: 'completed'; task: GoogleTask }> {
  if (knownTask?.deleted) return { kind: 'deleted' };
  if (knownTask?.status === 'completed') return { kind: 'completed', task: knownTask };
  // A full list is a read snapshot, not permission to delete a task that may
  // have completed while earlier batches were being reconciled.
  let task: GoogleTask;
  try {
    task = await api.getTask(accessToken, link.googleTaskListId, link.googleTaskId);
  } catch (error) {
    if (error instanceof GoogleTaskNotFoundError) return { kind: 'deleted' };
    throw error;
  }
  if (task && !task.deleted && task.status !== 'completed') {
    try {
      if (!isGoogleTaskETag(task.etag)) return { kind: 'deferred' };
      await api.deleteTask(accessToken, link.googleTaskListId, link.googleTaskId, task.etag);
    } catch (error) {
      if (error instanceof GoogleTasksApiError && error.status === 412) return { kind: 'deferred' };
      if (!(error instanceof GoogleTaskNotFoundError)) throw error;
    }
  }
  return task.status === 'completed' && !task.deleted ? { kind: 'completed', task } : { kind: 'deleted' };
}

function googleDueDate(localDate: string): string {
  return `${localDate}T00:00:00.000Z`;
}

function googleDueLocalDate(value: string | undefined): string | null {
  return value?.slice(0, 10) ?? null;
}
