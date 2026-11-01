import { createGoogleOperationBudget } from '../google-sync/operation-budget.ts';
import { withGoogleSyncOperation } from '../google-sync/operation-lock.ts';
import { GoogleAccountMismatchError } from '../google-sync/account-binding.ts';
import { GoogleCalendarHttpError } from '../../platform/google-calendar/calendar-api.ts';
import type { GoogleCalendarApi, GoogleCalendarListEntry } from '../../platform/google-calendar/calendar-api';
import type { SharedCalendarExportControl, SharedCalendarExportStore } from '../../platform/storage/sharing-v2-calendar-export';
import type { GoogleOperationBudget } from '../google-sync/operation-budget';
import { sharedDocumentDigest } from '../sharing/crypto.ts';
import { sharedLocalDate } from '../sharing/group-clock.ts';
import { googleEventBody } from './google-event-mapping.ts';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { projectCalendarEvents } from '../../domain/calendar/events.ts';

export function createSharedGoogleCalendarExport(input: { store: SharedCalendarExportStore; scope: { userId: string; groupId: string };
  assertAccess(): Promise<void>; currentSubject(): Promise<string | null>;
  authorize(expectedSubject?: string): Promise<{ subject: string; label: string }>;
  createApi(context: { subject: string; assertCurrent(): Promise<void>; signal: AbortSignal }): GoogleCalendarApi;
  now?: () => number; random?: () => number }) {
  const now = input.now ?? Date.now; const random = input.random ?? Math.random;
  let running: Promise<{ kind: 'success' | 'pending' | 'skipped' | 'error'; sent: number }> | null = null;
  let cancel: (() => void) | undefined;
  let activeBudget: GoogleOperationBudget | undefined;
  let activeInteractive = false;
  type Review = { revision: number; account: { subject: string; label: string }; calendars: GoogleCalendarListEntry[] };
  const reviews = new WeakMap<Review, { revision: number; subject: string; label: string; calendars: Map<string, GoogleCalendarListEntry> }>();
  const prepareConnection = () => withGoogleSyncOperation(async (): Promise<Review> => {
    await input.assertAccess(); const control = await input.store.readControl();
    // Reading and approving Google's consent screen is a human action, not HTTP time.
    const account = await input.authorize(control.subject ?? undefined);
    const budget = createGoogleOperationBudget(20_000);
    try {
      const guard = async () => { budget.assert(); await input.assertAccess(); if (await input.currentSubject() !== account.subject) throw new GoogleAccountMismatchError(); };
      const api = input.createApi({ subject: account.subject, assertCurrent: guard, signal: budget.signal });
      const calendars: GoogleCalendarListEntry[] = []; let page: string | undefined; const seen = new Set<string>();
      do {
        await guard(); const result = await api.calendars(page); await guard();
        for (const value of result.items ?? []) if (typeof value.id === 'string' && value.id.length <= 1024 && ['owner', 'writer'].includes(value.accessRole)) calendars.push({ ...value });
        page = result.nextPageToken; if (page && (seen.has(page) || seen.size >= 10)) throw new Error('カレンダー一覧を取得しきれません。'); if (page) seen.add(page);
      } while (page);
      const review: Review = { revision: control.revision, account: { ...account }, calendars };
      reviews.set(review, { revision: control.revision, subject: account.subject, label: account.label, calendars: new Map(calendars.map(value => [value.id, { ...value }])) }); return review;
    } finally { budget.close(); }
  });
  async function assertControl(control: SharedCalendarExportControl) {
    await input.assertAccess(); const current = await input.store.readControl();
    if (!current.enabled || current.revision !== control.revision || current.subject !== control.subject || current.calendarId !== control.calendarId
      || await input.currentSubject() !== control.subject) throw new GoogleAccountMismatchError();
  }
  const synchronize = (options: { budgetMs?: number; force?: boolean; interactive?: boolean } = {}): Promise<{ kind: 'success' | 'pending' | 'skipped' | 'error'; sent: number }> => {
    if (running) {
      // A user's fresh pass can follow a worker, but cannot extend its OS deadline.
      if (options.interactive && !activeInteractive) return running.then(() => synchronize(options));
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
        const guard = async () => { budget.assert(); await assertControl(control); };
        const api = input.createApi({ subject: control.subject!, assertCurrent: guard, signal: budget.signal });
        const request = async <T>(fn: () => Promise<T>): Promise<T> => { if (++calls > 100) throw Object.assign(new Error('続きは次の同期で送信します。'), { code: 'batch_limit' }); await guard(); return fn(); };
        try {
          await guard(); const items = await input.store.readItems(); const links = new Map((await input.store.readLinks(control.subject!, control.calendarId!)).map(link => [link.sourceId, link]));
          for (const item of items) {
            budget.assert(); const prior = links.get(item.sourceId); if (prior?.revision === item.revision) continue;
            if (sent >= 100) throw Object.assign(new Error('続きは次の同期で送信します。'), { code: 'batch_limit' });
            const sourceTag = sharedDocumentDigest([input.scope, item.sourceId]);
            let value = item.value; let remoteId = prior?.googleId; let etag = prior?.etag;
            if (item.parentId) {
              const parent = links.get(item.parentId); if (!parent || parent.deleted) continue;
              if (item.reset && !prior) continue;
              if (item.reset && value) value = projectCalendarEvents([{ ...value, id: item.parentId, revision: 1 }], [], item.anchorDate!, item.anchorDate!)[0] ?? null;
              if (prior && item.reset && value === null) { remoteId = prior.googleId; etag = prior.etag; }
              else {
                let page: string | undefined; let found; const seen = new Set<string>();
                do {
                  const result = await request(() => api.instances(control.calendarId!, parent.googleId, { timeMin: `${addDays(item.anchorDate!, -2)}T00:00:00Z`, timeMax: `${addDays(item.anchorDate!, 3)}T00:00:00Z`, pageToken: page }));
                  found = result.items?.find(event => event.recurringEventId === parent.googleId && (event.originalStartTime?.date
                    ?? (event.originalStartTime?.dateTime ? sharedLocalDate(new Date(event.originalStartTime.dateTime), items.find(row => row.sourceId === item.parentId)?.value?.timeZone ?? event.originalStartTime.timeZone ?? 'UTC') : undefined)) === item.anchorDate);
                  page = result.nextPageToken; if (page && seen.has(page)) throw new Error('Googleの繰り返し予定を読み直してください。'); if (page) seen.add(page);
                } while (!found && page);
                if (!found?.id || !found.etag) throw new Error('Google側の対象回を確認できません。変更は送信待ちです。');
                remoteId = found.id; etag = prior?.googleId === found.id ? prior.etag : found.etag;
              }
            }
            const body = value ? googleEventBody(value, Boolean(item.parentId)) : null;
            if (body === null) {
              if (remoteId && etag && !prior?.deleted) try { await request(() => api.remove(control.calendarId!, remoteId!, etag!)); }
              catch (cause) { if (!(cause instanceof GoogleCalendarHttpError && [404, 410].includes(cause.status))) throw cause; }
              const link = { sourceId: item.sourceId, googleId: remoteId ?? '', etag: etag ?? '', revision: item.revision, deleted: true };
              await input.store.saveLink(control.subject!, control.calendarId!, link); links.set(item.sourceId, link); sent++; continue;
            }
            const payload = { ...body, ...(item.reset ? { status: 'confirmed' } : {}),
              extendedProperties: { private: { liflowSource: sourceTag, liflowShared: '1', liflowRevision: item.revision } } };
            let result;
            if (remoteId && etag && (!prior?.deleted || item.parentId)) {
              try { result = await request(() => api.patch(control.calendarId!, remoteId!, payload, etag!)); }
              catch (cause) {
                if (!(cause instanceof GoogleCalendarHttpError && cause.status === 412)) throw cause;
                const received = await request(() => api.get(control.calendarId!, remoteId!));
                if (JSON.stringify(ownedFields(received)) !== JSON.stringify(ownedFields(payload))) throw cause;
                result = received;
              }
            }
            else {
              remoteId = `cf${sharedDocumentDigest([input.scope, control.subject, control.calendarId, item.sourceId, prior?.deleted ? item.revision : 'initial'])}`;
              try { result = await request(() => api.insert(control.calendarId!, { ...payload, id: remoteId })); }
              catch (cause) {
                if (!(cause instanceof GoogleCalendarHttpError && cause.status === 409)) throw cause;
                result = await request(() => api.get(control.calendarId!, remoteId!));
                if (result.extendedProperties?.private?.liflowSource !== sourceTag || result.extendedProperties.private.liflowRevision !== item.revision
                  || JSON.stringify(ownedFields(result)) !== JSON.stringify(ownedFields(payload))) throw new GoogleCalendarHttpError(412);
              }
            }
            if (!result.id || !result.etag) throw new Error('Googleの保存結果を確認できません。次の同期で照合します。');
            const link = { sourceId: item.sourceId, googleId: result.id, etag: result.etag, revision: item.revision, deleted: false };
            await input.store.saveLink(control.subject!, control.calendarId!, link); links.set(item.sourceId, link); sent++;
          }
          await input.store.saveStatus(control.revision, { error: null, retryAt: null, retryCount: 0, lastSyncAt: now(), pending: false });
          return { kind: 'success' as const, sent };
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
function ownedFields(value: Record<string, unknown>) {
  const result: Record<string, unknown> = {
    summary: value.summary ?? '', location: value.location ?? '', description: value.description ?? '',
    start: value.start, end: value.end, transparency: value.transparency ?? 'opaque', status: value.status ?? 'confirmed',
    recurrence: (Array.isArray(value.recurrence) ? value.recurrence : []).map(rule => {
      if (typeof rule !== 'string' || !rule.startsWith('RRULE:')) return rule;
      const parts = new Map(rule.slice(6).split(';').map(part => { const [key, contents] = part.split('='); return [key, contents?.split(',').sort().join(',')]; }));
      if (!parts.has('INTERVAL')) parts.set('INTERVAL', '1');
      if (!parts.has('WKST')) parts.set('WKST', 'MO');
      return [...parts].sort(([a], [b]) => a.localeCompare(b));
    }).sort(),
  };
  for (const key of ['start', 'end']) {
    const raw = result[key] as { date?: string; dateTime?: string; timeZone?: string } | undefined;
    if (raw?.dateTime) result[key] = { instant: Date.parse(raw.dateTime), timeZone: raw.timeZone };
  }
  return result;
}
export type SharedGoogleCalendarExport = ReturnType<typeof createSharedGoogleCalendarExport>;
