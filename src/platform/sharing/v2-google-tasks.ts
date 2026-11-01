import { randomUUID } from 'expo-crypto';
import type { createV2EventRepository } from '../storage/sharing-v2-events';
import { createV2GoogleTaskStore } from '../storage/sharing-v2-google-tasks';
import { createV2GoogleTaskRuntime } from '../../features/sharing/v2/google-tasks-runtime';
import { createGoogleTasksApi } from '../google-tasks/google-tasks-api';
import { authorizeGoogleTasks, getCurrentGoogleSubject, getGoogleTasksAccessToken, restorePrivateGoogleCalendarAccount } from '../google-tasks/google-sign-in-gateway';
import { readV2LocalPlanning } from './v2-local-planning';

/** Existing Native OAuth and HTTP client; no v1 repository adapter or personal Google connection is opened. */
export function createNativeV2GoogleTasks(input: { repository: ReturnType<typeof createV2EventRepository>; userId: string; groupId: string;
  assertAccess(): void | Promise<void>; onImported?(): void | Promise<void>;
  readPlanning?: (now: Date) => Promise<Pick<Awaited<ReturnType<typeof readV2LocalPlanning>>, 'revision' | 'personalize'>> }) {
  let local: Pick<Awaited<ReturnType<typeof readV2LocalPlanning>>, 'revision' | 'personalize'> | undefined;
  const store = createV2GoogleTaskStore({ ...input, makeId: randomUUID, now: () => new Date(),
    planningRevision: () => local?.revision ?? 'unprepared', personalize: (plan, calendar) => {
      if (!local) throw new Error('本人の予定を読み直してください。'); return local.personalize(plan, calendar);
    } });
  return createV2GoogleTaskRuntime({ ...input, store, currentSubject: getCurrentGoogleSubject,
    restoreAccount: restorePrivateGoogleCalendarAccount, authorizeTasks: authorizeGoogleTasks, token: getGoogleTasksAccessToken,
    preparePlan: async () => { const now = new Date(); local = await (input.readPlanning ? input.readPlanning(now) : readV2LocalPlanning(input, now)); await input.assertAccess(); },
    createApi: ({ budget, assertCurrent }) => createGoogleTasksApi(async (resource, init) => {
      await assertCurrent(); const controller = new AbortController(); const abort = () => controller.abort();
      const signals = [budget.signal, init?.signal].filter((signal): signal is AbortSignal => Boolean(signal));
      for (const signal of signals) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', abort, { once: true }); }
      budget.onClose(() => { for (const signal of signals) signal.removeEventListener('abort', abort); });
      return fetch(resource, { ...init, signal: controller.signal });
    }),
  });
}
