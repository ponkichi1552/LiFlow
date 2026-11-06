import { GoogleTasksApiError, GoogleTaskNotFoundError } from '../../platform/google-tasks/google-tasks-api.ts';
import type { GoogleTask, GoogleTasksApi, GoogleTasksPage } from '../../platform/google-tasks/google-tasks-api';

export interface GoogleTaskReadScope { accountSubject: string; taskListId: string }
export interface GoogleTaskReadState {
  revision: number;
  complete: boolean;
  watermark: string | null;
  lastFullAt: string | null;
  scan: null | { mode: 'full' | 'delta'; updatedMin: string | null; pageToken: string | null;
    visitedTokens: string[]; cutoff: string | null; pages: number };
}
export interface GoogleTaskReadCache {
  read(scope: GoogleTaskReadScope): Promise<GoogleTaskReadState>;
  start(scope: GoogleTaskReadScope, expected: GoogleTaskReadState, now: string, options?: { deltaOnly?: boolean }): Promise<GoogleTaskReadState>;
  page(scope: GoogleTaskReadScope, expected: GoogleTaskReadState, page: GoogleTasksPage, now: string): Promise<GoogleTaskReadState>;
  reset(scope: GoogleTaskReadScope, expected: GoogleTaskReadState): Promise<void>;
  tasks(scope: GoogleTaskReadScope): Promise<GoogleTask[]>;
}
export const TASK_CACHE_FULL_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const retryRead = () => new GoogleTasksApiError(503, 'task_read_restart', null);
export class GoogleTaskFullSyncRequiredError extends Error {
  constructor() { super('Google Tasksの初回・再取得はアプリ表示中に続けます。'); this.name = 'GoogleTaskFullSyncRequiredError'; }
}
export function canReadGoogleTaskDelta(state: GoogleTaskReadState, now: Date): boolean {
  const lastFull = Date.parse(state.lastFullAt ?? '');
  const watermark = Date.parse(state.watermark ?? '');
  return state.complete && Number.isFinite(lastFull) && Number.isFinite(watermark)
    && Number.isFinite(now.getTime()) && now.getTime() >= lastFull;
}
export function googleTaskFullReadRequired(state: GoogleTaskReadState, now: Date): boolean {
  return !canReadGoogleTaskDelta(state, now)
    || now.getTime() - Date.parse(state.lastFullAt!) >= TASK_CACHE_FULL_REFRESH_MS;
}

/** No partial list is reconciled. Committed pages survive process death and only a finished scan advances its watermark. */
export async function readGoogleTasksCheckpointed(input: { api: GoogleTasksApi; cache: GoogleTaskReadCache;
  scope: GoogleTaskReadScope; accessToken: string; now: Date; deltaOnly?: boolean; onPage?(tasks: readonly GoogleTask[]): void }): Promise<GoogleTask[]> {
  if (!input.api.listTaskPage) {
    if (input.deltaOnly) throw new GoogleTaskFullSyncRequiredError();
    const tasks = await input.api.listTasks(input.accessToken, input.scope.taskListId); input.onPage?.(tasks); return tasks;
  }
  let state = await input.cache.read(input.scope);
  if (input.deltaOnly && (state.scan ? state.scan.mode !== 'delta' : !canReadGoogleTaskDelta(state, input.now))) throw new GoogleTaskFullSyncRequiredError();
  if (!state.scan) state = await input.cache.start(input.scope, state, input.now.toISOString(), { deltaOnly: input.deltaOnly });
  while (state.scan) {
    let page: GoogleTasksPage;
    try { page = await input.api.listTaskPage(input.accessToken, input.scope.taskListId, {
      ...(state.scan.pageToken ? { pageToken: state.scan.pageToken } : {}),
      ...(state.scan.updatedMin ? { updatedMin: state.scan.updatedMin } : {}),
    }); } catch (error) {
      if (input.deltaOnly && (error instanceof GoogleTaskNotFoundError || error instanceof GoogleTasksApiError && [400, 410].includes(error.status))) {
        await input.cache.reset(input.scope, state); throw new GoogleTaskFullSyncRequiredError();
      }
      // Page tokens are opaque and may expire. Never treat an incomplete traversal as remote deletion.
      if (state.scan.pageToken && (error instanceof GoogleTasksApiError && [400, 410].includes(error.status)
        || error instanceof GoogleTaskNotFoundError)) {
        await input.cache.reset(input.scope, state); throw input.deltaOnly ? new GoogleTaskFullSyncRequiredError() : retryRead();
      }
      throw error;
    }
    input.onPage?.(page.items);
    if (page.nextPageToken && state.scan.visitedTokens.includes(page.nextPageToken)) {
      await input.cache.reset(input.scope, state); throw input.deltaOnly ? new GoogleTaskFullSyncRequiredError() : retryRead();
    }
    // A cutoff comes from Google's response clock, never the device clock. A regressing server boundary forces a full rebuild.
    const at = page.serverDate && Date.parse(page.serverDate);
    if (!state.scan.pages && state.scan.updatedMin && at && at < Date.parse(state.scan.updatedMin)) {
      await input.cache.reset(input.scope, state); throw input.deltaOnly ? new GoogleTaskFullSyncRequiredError() : retryRead();
    }
    state = await input.cache.page(input.scope, state, page, input.now.toISOString());
  }
  return input.cache.tasks(input.scope);
}
