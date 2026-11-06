/** A private receipt for a non-idempotent Google Tasks insert. Never part of shared data. */
export interface GoogleTaskCreateIdentity {
  accountSubject: string;
  taskListId: string;
  occurrenceMarker: string;
}
export interface GoogleTaskCreateIntent extends GoogleTaskCreateIdentity {
  attemptId: string;
  startedAt: string;
}
export interface GoogleTaskCreateJournal {
  /** Only the caller that durably inserted this attempt may issue the HTTP insert. */
  reserve(identity: GoogleTaskCreateIdentity): Promise<GoogleTaskCreateIntent | null>;
  /** Native shared adapters reserve one HTTP chunk in one authorized SQLite transaction. */
  reserveBatch?(identities: readonly GoogleTaskCreateIdentity[], beforeCommit?: () => void): Promise<readonly (GoogleTaskCreateIntent | null)[]>;
  /** An explicit rejected HTTP item can be retried. An uncertain response cannot. */
  reject(intent: GoogleTaskCreateIntent): Promise<void>;
  rejectBatch?(intents: readonly GoogleTaskCreateIntent[]): Promise<void>;
  /** Keep a durable receipt after saving the link; a stale concurrent read must not open another insert. */
  linked(identity: GoogleTaskCreateIdentity, taskId: string): Promise<void>;
  /** A fresh explicit deletion of this exact recorded task permits its normal repair. */
  deleted(identity: GoogleTaskCreateIdentity, taskId: string): Promise<void>;
}

export function isDefinitiveGoogleTaskInsertRejection(status: number): boolean {
  // A server failure or lost response may follow a committed insert. Never
  // interpret those as proof that issuing another POST is harmless.
  return [400, 401, 403, 404, 405, 409, 410, 412, 413, 415, 422, 429].includes(status);
}

/** Only a local preflight, before invoking the transport, may attach this marker. */
export function googleTaskRequestNotSent(cause: unknown): Error & { requestNotSent: true; code?: string } {
  const error = new Error(cause instanceof Error ? cause.message : 'Google家事の送信を開始できませんでした。', { cause });
  error.name = cause instanceof Error ? cause.name : 'Error';
  const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
  return Object.assign(error, { requestNotSent: true as const, ...(code ? { code } : {}) });
}
export function googleTaskRequestWasNotSent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'requestNotSent' in error && error.requestNotSent === true);
}
