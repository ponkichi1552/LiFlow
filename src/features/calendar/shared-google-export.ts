import { createGoogleOperationBudget, withinGoogleOperationBudget } from '../google-sync/operation-budget.ts';
import { withGoogleSyncOperation } from '../google-sync/operation-lock.ts';
import { GoogleAccountMismatchError } from '../google-sync/account-binding.ts';
import { canWriteGoogleCalendar, GoogleCalendarHttpError, normalizeGoogleCalendars } from '../../platform/google-calendar/calendar-api.ts';
import type { GoogleCalendarApi, GoogleCalendarListEntry, GoogleCalendarEvent } from '../../platform/google-calendar/calendar-api';
import type { SharedCalendarExportControl, SharedCalendarExportStore, SharedCalendarExportLink, SharedCalendarExportIntent } from '../../platform/storage/sharing-v2-calendar-export';
import type { GoogleOperationBudget } from '../google-sync/operation-budget';
import { sharedDocumentDigest } from '../sharing/crypto.ts';
import { googleEventBody } from './google-event-mapping.ts';
import { googleOwnedFields } from './google-owned-fields.ts';
import { findGoogleCalendarInstance, calendarOccurrenceAt } from './google-instance.ts';

export function createSharedGoogleCalendarExport(input: { store: SharedCalendarExportStore; scope: { userId: string; groupId: string };
  assertAccess(): Promise<void>; currentSubject(): Promise<string | null>;
  authorize(expectedSubject?: string): Promise<{ subject: string; label: string }>;
  createApi(context: { subject: string; assertCurrent(): Promise<void>; signal: AbortSignal }): GoogleCalendarApi;
  now?: () => number; random?: () => number }) {
  const now = input.now ?? Date.now; const random = input.random ?? Math.random;
  type Result = { kind: 'success' | 'pending' | 'skipped' | 'error'; sent: number };
  let running: Promise<Result> | null = null;
  const followups = new WeakMap<Promise<Result>, { promise: Promise<Result>; budget: GoogleOperationBudget }>();
  let cancel: (() => void) | undefined;
  let activeBudget: GoogleOperationBudget | undefined;
  let activeInteractive = false;
  type Review = { revision: number; account: { subject: string; label: string }; calendars: GoogleCalendarListEntry[] };
  const reviews = new WeakMap<Review, { revision: number; subject: string; label: string; calendars: Map<string, GoogleCalendarListEntry> }>();
  const prepareConnection = (options: { replaceAccount?: boolean } = {}) => withGoogleSyncOperation(async (): Promise<Review> => {
    await input.assertAccess(); const control = await input.store.readControl();
    // Reading and approving Google's consent screen is a human action, not HTTP time.
    const account = await input.authorize(options.replaceAccount === true ? undefined : control.subject ?? undefined);
    const budget = createGoogleOperationBudget(20_000);
    try {
      const guard = async () => { budget.assert(); await input.assertAccess(); if (await withinGoogleOperationBudget(budget, input.currentSubject) !== account.subject) throw new GoogleAccountMismatchError(); };
      const api = input.createApi({ subject: account.subject, assertCurrent: guard, signal: budget.signal });
      const calendars: GoogleCalendarListEntry[] = []; let page: string | undefined; const seen = new Set<string>();
      do {
        await guard(); const result = await api.calendars(page); await guard();
        for (const value of result.items ?? []) if (typeof value.id === 'string' && value.id.length <= 1024 && canWriteGoogleCalendar(value)) calendars.push({ ...value });
        page = result.nextPageToken; if (page && (seen.has(page) || seen.size >= 10)) throw new Error('カレンダー一覧を取得しきれません。'); if (page) seen.add(page);
      } while (page);
      const review: Review = { revision: control.revision, account: { ...account }, calendars: normalizeGoogleCalendars(calendars) };
      reviews.set(review, { revision: control.revision, subject: account.subject, label: account.label, calendars: new Map(calendars.map(value => [value.id, { ...value }])) }); return review;
    } finally { budget.close(); }
  });
  async function assertControl(control: SharedCalendarExportControl, budget: GoogleOperationBudget) {
    await input.assertAccess(); const current = await input.store.readControl();
    if (!current.enabled || current.revision !== control.revision || current.subject !== control.subject || current.calendarId !== control.calendarId
      || await withinGoogleOperationBudget(budget, input.currentSubject) !== control.subject) throw new GoogleAccountMismatchError();
  }
  const synchronize = (options: { budgetMs?: number; force?: boolean; interactive?: boolean } = {}): Promise<{ kind: 'success' | 'pending' | 'skipped' | 'error'; sent: number }> => {
    if (running) {
      // An edit can arrive after the active pass captured its source. Preserve
      // one trailing pass with its own deadline instead of losing that trigger.
      if (options.force || options.interactive && !activeInteractive) {
        const active = running; const following = followups.get(active);
        if (following) { if (options.budgetMs !== undefined) following.budget.shrink(options.budgetMs); return following.promise; }
        const limit = options.interactive ? 90_000 : 20_000;
        const budget = createGoogleOperationBudget(Math.min(limit, options.budgetMs ?? limit));
        const promise = (async (): Promise<Result> => {
          try {
            await withinGoogleOperationBudget(budget, () => active);
            return await synchronize({ ...options, budgetMs: Math.floor(budget.remaining()) });
          } catch (cause) {
            if (cause instanceof Error && cause.name === 'AbortError') return { kind: 'pending', sent: 0 };
            throw cause;
          } finally { budget.close(); followups.delete(active); }
        })();
        followups.set(active, { promise, budget }); return promise;
      }
      if (options.budgetMs !== undefined) activeBudget?.shrink(Math.min(20_000, options.budgetMs));
      return running;
    }
    const limit = options.interactive ? 90_000 : 20_000;
    const budget = createGoogleOperationBudget(Math.min(limit, options.budgetMs ?? limit)); cancel = budget.cancel;
    activeBudget = budget; activeInteractive = options.interactive === true;
    const work = (async () => {
      await input.assertAccess(); const control = await input.store.readControl();
      // OFF is a complete no-op: no native token, Google reads, writes or deletes.
      if (!control.enabled || !control.subject || !control.calendarId) return { kind: 'skipped' as const, sent: 0 };
      if (!options.force && control.retryAt && control.retryAt > now()) return { kind: 'pending' as const, sent: 0 };
      return withGoogleSyncOperation(async () => {
        let sent = 0; let calls = 0;
        const guard = async () => { budget.assert(); await assertControl(control, budget); };
        const api = input.createApi({ subject: control.subject!, assertCurrent: guard, signal: budget.signal });
        const request = async <T>(fn: () => Promise<T>): Promise<T> => { if (++calls > 100) throw Object.assign(new Error('続きは次の同期で送信します。'), { code: 'batch_limit' }); await guard(); const value = await fn(); await guard(); return value; };
        try {
          await guard(); const items = await input.store.readItems(); const links = new Map((await input.store.readLinks(control.subject!, control.calendarId!)).map(link => [link.sourceId, link]));
          const itemsById = new Map(items.map(item => [item.sourceId, item]));
          const save = async (link: SharedCalendarExportLink) => {
            await input.store.saveLink(control.subject!, control.calendarId!, link); links.set(link.sourceId, link);
          };
          const knownSeries = async (link: SharedCalendarExportLink, current: GoogleCalendarEvent) => {
            const marker = current.extendedProperties?.private;
            if (current.id !== link.pending!.googleId || !current.etag || marker?.liflowShared !== '1'
              || marker.liflowSource !== sharedDocumentDigest([input.scope, link.sourceId]) || !marker.liflowRevision) return null;
            const proof = await input.store.knownSeriesRevision?.(link.sourceId, marker.liflowRevision);
            if (!proof || proof.fields !== googleOwnedFields(current)) return null;
            if (proof.currentRevision !== itemsById.get(link.sourceId)?.revision) throw Object.assign(new Error('共有予定が更新されました。'), { code: 'export_source_changed' });
            return { sourceId: link.sourceId, googleId: current.id, etag: current.etag, revision: marker.liflowRevision, deleted: false };
          };
          const send = async (link: SharedCalendarExportLink) => {
            const intent = link.pending!; let result;
            if (intent.method === 'delete') {
              try { await request(() => api.remove(control.calendarId!, intent.googleId, intent.etag)); }
              catch (cause) {
                if (!(cause instanceof GoogleCalendarHttpError)) throw cause;
                if (cause.status === 412) {
                  const current = await request(() => api.get(control.calendarId!, intent.googleId));
                  if (current.status !== 'cancelled') {
                    const known = await knownSeries(link, current); if (!known) throw cause;
                    if (intent.revision !== itemsById.get(link.sourceId)?.revision) { await save(known); sent++; return known; }
                    const pending = { ...intent, etag: known.etag }; await save({ ...link, pending });
                    await request(() => api.remove(control.calendarId!, pending.googleId, pending.etag));
                  }
                } else if (![404, 410].includes(cause.status)) throw cause;
              }
            } else {
              try {
                result = intent.method === 'patch'
                  ? await request(() => api.patch(control.calendarId!, intent.googleId, intent.payload!, intent.etag))
                  : await request(() => api.insert(control.calendarId!, { ...intent.payload!, id: intent.googleId }));
              } catch (cause) {
                if (!(cause instanceof GoogleCalendarHttpError && cause.status === (intent.method === 'insert' ? 409 : 412))) throw cause;
                const current = await request(() => api.get(control.calendarId!, intent.googleId));
                const expected = intent.payload as { extendedProperties?: { private?: Record<string, string> } };
                if (current.id !== intent.googleId) throw new GoogleCalendarHttpError(502);
                if (current.extendedProperties?.private?.liflowSource !== expected.extendedProperties?.private?.liflowSource
                  || intent.method === 'insert' && current.extendedProperties?.private?.liflowRevision !== intent.revision
                  || googleOwnedFields(current) !== googleOwnedFields(intent.payload!)) {
                  const known = await knownSeries(link, current); if (!known) throw new GoogleCalendarHttpError(412);
                  if (intent.revision !== itemsById.get(link.sourceId)?.revision) { await save(known); sent++; return known; }
                  const pending = { ...intent, method: 'patch' as const, etag: known.etag };
                  await save({ ...link, pending });
                  result = await request(() => api.patch(control.calendarId!, pending.googleId, pending.payload!, pending.etag));
                } else result = current;
              }
              if (!result.id || !result.etag) throw new Error('Googleの保存結果を確認できません。次の同期で照合します。');
            }
            const accepted: SharedCalendarExportLink = { sourceId: link.sourceId, googleId: result?.id ?? intent.googleId,
              etag: result?.etag ?? intent.etag, revision: intent.revision, deleted: intent.method === 'delete' };
            await save(accepted); sent++; return accepted;
          };
          let waiting = false; let heldConflict: GoogleCalendarHttpError | null = null;
          for (const item of items) {
            if (item.blocked) { waiting = true; continue; }
            try {
              budget.assert(); let prior = links.get(item.sourceId);
              // Resolve the exact previous request before considering a newer source
              // revision. Its payload and ETag survived response loss or process exit.
              if (prior?.pending) prior = await send(prior);
              if (prior?.revision === item.revision) continue;
              if (sent >= 100) throw Object.assign(new Error('続きは次の同期で送信します。'), { code: 'batch_limit' });
              const sourceTag = sharedDocumentDigest([input.scope, item.sourceId]);
              let value = item.value; let remoteId = prior?.googleId; let etag = prior?.etag;
              if (item.parentId) {
                const parent = links.get(item.parentId);
                if (!parent || parent.deleted || parent.pending || itemsById.get(item.parentId)?.blocked) { waiting = true; continue; }
                if (item.reset && !prior) continue;
                if (item.reset && value) value = calendarOccurrenceAt(value, item.parentId, item.anchorDate!);
                if (prior && item.reset && value === null) { remoteId = prior.googleId; etag = prior.etag; }
                else {
                  const series = itemsById.get(item.parentId)?.value;
                  const found = await findGoogleCalendarInstance({ api, request, calendarId: control.calendarId!, parentId: parent.googleId,
                    anchorDate: item.anchorDate!, series, knownId: prior?.googleId });
                  if (!found.etag) throw new Error('Google側の対象回を確認できません。変更は送信待ちです。');
                  remoteId = found.id;
                  // A successful earlier delete has a pre-delete ETag. Only a verified
                  // tombstone of that exact occurrence may supply a restoration ETag.
                  etag = prior?.googleId === found.id && !(prior.deleted && item.reset && found.status === 'cancelled') ? prior.etag : found.etag;
                }
              }
              const body = value ? googleEventBody(value, Boolean(item.parentId)) : null;
              if (body === null && (!remoteId || !etag || prior?.deleted)) {
                await save({ sourceId: item.sourceId, googleId: remoteId ?? '', etag: etag ?? '', revision: item.revision, deleted: true }); sent++; continue;
              }
              const payload = body === null ? null : { ...body, ...(item.reset ? { status: 'confirmed' } : {}),
                extendedProperties: { private: { liflowSource: sourceTag, liflowShared: '1', liflowRevision: item.revision } } };
              const method = body === null ? 'delete' : remoteId && etag && (!prior?.deleted || item.parentId) ? 'patch' : 'insert';
              if (method === 'insert') remoteId = `cf${sharedDocumentDigest([input.scope, control.subject, control.calendarId, item.sourceId, prior?.deleted ? item.revision : 'initial'])}`;
              const intent: SharedCalendarExportIntent = { method, googleId: remoteId!, etag: etag ?? '', revision: item.revision, payload };
              const reserved: SharedCalendarExportLink = { sourceId: item.sourceId, googleId: prior?.googleId ?? '', etag: prior?.etag ?? '', revision: prior?.revision ?? '', deleted: prior?.deleted ?? false, pending: intent };
              await save(reserved); await send(reserved);
            } catch (cause) {
              if (cause instanceof GoogleCalendarHttpError && [400, 404, 409, 410, 412].includes(cause.status)) { heldConflict ??= cause; waiting = true; continue; }
              if (cause instanceof Error && 'code' in cause && cause.code === 'export_source_changed') { waiting = true; continue; }
              throw cause;
            }
          }
          await input.store.saveStatus(control.revision, { error: heldConflict?.message ?? null, retryAt: heldConflict ? now() + 60_000 : null, retryCount: heldConflict ? control.retryCount + 1 : 0,
            ...(!waiting ? { lastSyncAt: now() } : {}), pending: waiting });
          return { kind: heldConflict ? 'error' as const : waiting ? 'pending' as const : 'success' as const, sent };
        } catch (cause) {
          const limited = cause instanceof Error && ('code' in cause && cause.code === 'batch_limit' || cause.name === 'AbortError');
          const delay = cause instanceof GoogleCalendarHttpError && cause.retryAfterMs || Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(control.retryCount, 9)) * (.75 + random() * .5);
          await input.store.saveStatus(control.revision, { error: limited ? null : cause instanceof Error ? cause.message : '共有予定をGoogleへ追加できませんでした。',
            retryAt: limited ? null : now() + Math.ceil(delay), retryCount: limited ? 0 : control.retryCount + 1, pending: true });
          return { kind: limited ? 'pending' as const : 'error' as const, sent };
        }
      });
    })().finally(() => { budget.close(); if (running === work) { running = null; cancel = undefined; activeBudget = undefined; activeInteractive = false; } });
    running = work; return work;
  };
  return { readControl: input.store.readControl, synchronize, prepareConnection,
    async connect(review: Review, calendarId: string) {
      await input.assertAccess(); const captured = reviews.get(review); const calendar = captured?.calendars.get(calendarId);
      if (!captured || !calendar || await input.currentSubject() !== captured.subject) throw new GoogleAccountMismatchError();
      cancel?.(); const result = await input.store.configure({ enabled: true, subject: captured.subject, accountLabel: captured.label, calendarId, calendarLabel: calendar.summary }, captured.revision);
      reviews.delete(review); return result;
    },
    async disable(revision: number) { cancel?.(); await input.assertAccess(); return input.store.configure({ enabled: false }, revision); },
  };
}
export type SharedGoogleCalendarExport = ReturnType<typeof createSharedGoogleCalendarExport>;
