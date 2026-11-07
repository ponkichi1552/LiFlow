import { randomUUID } from 'expo-crypto';
import { AppState } from 'react-native';
import type { createV2EventRepository } from '../storage/sharing-v2-events';
import { createV2GoogleTaskStore } from '../storage/sharing-v2-google-tasks';
import { createV2GoogleTaskRuntime } from '../../features/sharing/v2/google-tasks-runtime';
import { createGoogleTasksApi } from '../google-tasks/google-tasks-api';
import { authorizeGoogleTasks, getCurrentGoogleSubject, getGoogleTasksAccessToken, restorePrivateGoogleCalendarAccount } from '../google-tasks/google-sign-in-gateway';
import { readV2LocalPlanning } from './v2-local-planning';
import { googleTaskRequestNotSent } from '../../features/google-sync/task-create-intent.ts';
import { sharedTaskCreateJournal } from '../../features/google-sync/shared-task-create-journal';
import { resolveSharedGoogleTaskList, verifySharedTaskListForLocalChanges } from '../../features/google-sync/shared-task-list';
import type { GoogleOperationBudget } from '../../features/google-sync/operation-budget';
import { createSharedGoogleTaskClaims } from './google-task-claims';
import { getSharingServices } from './firebase-services';

/** Existing Native OAuth and HTTP client; no v1 repository adapter or personal Google connection is opened. */
export function createNativeV2GoogleTasks(input: { repository: ReturnType<typeof createV2EventRepository>; userId: string; groupId: string;
  assertAccess(): void | Promise<void>; onImported?(): void | Promise<void>;
  readPlanning?: (now: Date) => Promise<Pick<Awaited<ReturnType<typeof readV2LocalPlanning>>, 'revision' | 'personalize'> & Partial<Pick<Awaited<ReturnType<typeof readV2LocalPlanning>>, 'assertCurrent' | 'dispose'>>> }) {
  let local: Pick<Awaited<ReturnType<typeof readV2LocalPlanning>>, 'revision' | 'personalize'> & Partial<Pick<Awaited<ReturnType<typeof readV2LocalPlanning>>, 'assertCurrent' | 'dispose'>> | undefined;
  const store = createV2GoogleTaskStore({ ...input, makeId: randomUUID, now: () => new Date(),
    planningRevision: () => local?.revision ?? 'unprepared', personalize: (plan, calendar) => {
      if (!local) throw new Error('本人の予定を読み直してください。'); return local.personalize(plan, calendar);
    } });
  type Context = { budget: GoogleOperationBudget; assertCurrent(): Promise<void> };
  const prepared = new WeakMap<Context, ReturnType<typeof createSharedGoogleTaskClaims>>();
  const cloud = (context: Context) => {
    let service = prepared.get(context);
    if (!service) {
      const services = getSharingServices();
      service = createSharedGoogleTaskClaims({ firestore: services.firestore, userId: input.userId,
        namespace: store.port.taskNamespace!, currentUserId: () => services.auth.currentUser?.uid ?? null, assertCurrent: context.assertCurrent });
      prepared.set(context, service);
    }
    return service;
  };
  return createV2GoogleTaskRuntime({ ...input, store, currentSubject: getCurrentGoogleSubject,
    defaultBudgetMs: () => AppState.currentState === 'active' ? 100_000 : 15_000,
    defaultDeltaOnly: () => AppState.currentState !== 'active',
    restoreAccount: restorePrivateGoogleCalendarAccount, authorizeTasks: authorizeGoogleTasks, token: getGoogleTasksAccessToken,
    preparePlan: async () => { const now = new Date(); local?.dispose?.(); local = await (input.readPlanning ? input.readPlanning(now) : readV2LocalPlanning(input, now)); await input.assertAccess(); },
    assertPlanningCurrent: async () => { await local?.assertCurrent?.(); },
    finishPlan: () => { local?.dispose?.(); },
    resolveTaskList: (request, context) => resolveSharedGoogleTaskList(request, { namespace: store.port.taskNamespace!,
      cloud: () => cloud(context), journal: store.port.taskCreateJournal, makeId: randomUUID, context }),
    verifyTaskListForLocalChanges: (state, context) => verifySharedTaskListForLocalChanges(state, {
      namespace: store.port.taskNamespace!, cloud: () => cloud(context), context }),
    wrapCreateJournal: (journal, context) => sharedTaskCreateJournal(journal, {
      reserveBatch: intents => cloud(context).reserveBatch(intents), reject: intent => cloud(context).reject(intent),
      rejectBatch: intents => cloud(context).rejectBatch(intents),
      linked: (identity, taskId, attemptId) => cloud(context).linked(identity, taskId, attemptId), deleted: (identity, taskId, attemptId) => cloud(context).deleted(identity, taskId, attemptId),
    }, context),
    createApi: ({ budget, assertCurrent }) => createGoogleTasksApi(async (resource, init) => {
      try { await assertCurrent(); await local?.assertCurrent?.(); } catch (error) { throw googleTaskRequestNotSent(error); }
      return fetch(resource, init);
    }, undefined, { budget }),
  });
}
