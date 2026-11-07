import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '../../domain/shared/types';
import { withGoogleSyncOperation } from '../google-sync/operation-lock.ts';
import { createGoogleOperationBudget, withinGoogleOperationBudget } from '../google-sync/operation-budget.ts';
import { GoogleAccountMismatchError } from '../google-sync/account-binding.ts';
import { canReadGoogleCalendar, canWriteGoogleCalendar, GoogleCalendarHttpError, normalizeGoogleCalendars } from '../../platform/google-calendar/calendar-api.ts';
import type { GoogleCalendarApi, GoogleCalendarEvent, GoogleCalendarListEntry } from '../../platform/google-calendar/calendar-api';
import { connectPersonalGoogleCalendar, disablePersonalGoogleCalendar, readPersonalGoogleCalendarControl, refreshPersonalGoogleCalendars, updatePersonalGoogleCalendarStatus, withPersonalGoogleCalendar } from '../../platform/storage/personal-google-calendar.ts';
import type { PersonalGoogleCalendarControl } from '../../platform/storage/personal-google-calendar';
import { googleReadOnlyInstance, isLegacyHiddenGoogleParent, listPersonalGoogleItems, localGoogleItem, personalGoogleBody, personalGoogleDigest, receivePersonalGoogleEvent, writePersonalGoogleLink } from '../../platform/storage/personal-google-store.ts';
import { findGoogleCalendarInstance } from './google-instance.ts';
import { desiredGoogleExpansionRange, googleRangeContains, missingGoogleExpansionRanges, mergeGoogleExpansionRanges, retainGoogleDisplayRange } from '../../platform/storage/personal-google-ranges.ts';
import type { PersonalGoogleLink, PersonalGoogleWriteIntent } from '../../platform/storage/personal-google-store';
import { notifyCalendarSyncChanged } from '../../platform/storage/calendar-events.ts';
import { googleOwnedFields } from './google-owned-fields.ts';
import { traceStartup } from '../../platform/diagnostics/startup-timing.ts';
import { advanceCalendarPageHistory } from './page-history.ts';

class CalendarPassPending extends Error { readonly code = 'calendar/pass-pending'; }
type Result = { kind: 'success' | 'pending' | 'error' | 'skipped'; received: number; sent: number; retryAt?: number; waiting?: number };
export function createPersonalGoogleCalendarSync(input: { database: SQLiteDatabase; currentSubject(): Promise<string | null>;
  authorize(): Promise<{ subject: string; label: string }>;
  createApi(context: { subject: string; assertCurrent(): Promise<void>; signal: AbortSignal }): GoogleCalendarApi;
  today(): LocalDate; now?: () => number; random?: () => number }) {
  const now = input.now ?? Date.now; const random = input.random ?? Math.random;
  let running: Promise<Result> | null = null; let activeBudget: ReturnType<typeof createGoogleOperationBudget> | undefined;
  const followups = new WeakMap<Promise<Result>, { promise: Promise<Result>; budget: ReturnType<typeof createGoogleOperationBudget> }>();
  type Review = { generation: number; account: { subject: string; label: string }; calendars: GoogleCalendarListEntry[] };
  const reviews = new WeakMap<Review, Review>();
  async function prepareConnection(): Promise<Review> {
    return withGoogleSyncOperation(async () => {
      const previous = await readPersonalGoogleCalendarControl(input.database); const account = await input.authorize();
      const budget = createGoogleOperationBudget(20_000, now);
      try {
        const guard = async () => { budget.assert(); if (await withinGoogleOperationBudget(budget, () => input.currentSubject()) !== account.subject) throw new GoogleAccountMismatchError(); };
        const api = input.createApi({ subject: account.subject, assertCurrent: guard, signal: budget.signal });
        const calendars: GoogleCalendarListEntry[] = []; let page: string | undefined; const seen = new Set<string>();
        do {
          await guard(); const result = await api.calendars(page); await guard();
          for (const row of result.items ?? []) if (row.id && typeof row.summary === 'string' && canReadGoogleCalendar(row)) calendars.push({ ...row });
          page = result.nextPageToken;
          if (page && (seen.has(page) || seen.size >= 10)) throw new Error('カレンダー一覧を読み直してください。'); if (page) seen.add(page);
        } while (page);
        const review = { generation: previous.generation, account: { ...account }, calendars: normalizeGoogleCalendars(calendars) };
        reviews.set(review, { ...review, account: { ...account }, calendars: review.calendars.map(row => ({ ...row })) }); return review;
      } finally { budget.close(); }
    }, 'googleCalendar.authorize');
  }
  const sync = (options: { interactive?: boolean; force?: boolean; budgetMs?: number; deltaOnly?: boolean } = {}): Promise<Result> => {
    if (running) {
      if (options.budgetMs !== undefined) activeBudget?.shrink(options.budgetMs);
      if (!options.force && !options.interactive) return running;
      const active = running; const following = followups.get(active);
      if (following) { if (options.budgetMs !== undefined) following.budget.shrink(options.budgetMs); return following.promise; }
      // An edit/conflict resolution may arrive after this pass selected its
      // candidates. Coalesce one trailing pass, within this caller's own budget.
      const limit=options.interactive?90_000:20_000;
      const retryBudget=createGoogleOperationBudget(Math.min(limit,options.budgetMs??limit),now);
      const promise=(async():Promise<Result>=>{
        try {
          const result=await withinGoogleOperationBudget(retryBudget,()=>active);
          if (!options.force && result.kind!=='pending') return result;
          retryBudget.assert();
          return await withinGoogleOperationBudget(retryBudget,()=>sync({...options,budgetMs:Math.floor(retryBudget.remaining())}));
        } catch(error) { if(error instanceof Error && error.name==='AbortError')return{kind:'pending',received:0,sent:0};throw error; }
        finally { retryBudget.close();followups.delete(active); }
      })();
      followups.set(active,{promise,budget:retryBudget});return promise;
    }
    const limit = options.interactive ? 90_000 : 20_000;
    const budget = createGoogleOperationBudget(Math.min(limit, options.budgetMs ?? limit), now); activeBudget = budget;
    const work = (async (): Promise<Result> => {
      let control = await traceStartup('googleCalendar.control', () => readPersonalGoogleCalendarControl(input.database));
      if (!control.enabled || !control.subject) return { kind: 'skipped', received: 0, sent: 0 };
      if (!options.force && control.retryAt > now()) return { kind: 'pending', received: 0, sent: 0, retryAt: control.retryAt };
      return withGoogleSyncOperation(async () => {
        let calls = 0; let received = 0; let sent = 0; let changed = false; let localCandidates: number | null = null;
        const finish = (result: Result): Result => {
          if (process.env.EXPO_PUBLIC_LIFLOW_STARTUP_TRACE === '1') console.info('[LiFlow Calendar sync]', { kind: result.kind, calls, received, sent, localCandidates });
          return result;
        };
        const guard = async () => {
          budget.assert(); if (await withinGoogleOperationBudget(budget, () => traceStartup('googleCalendar.identity', input.currentSubject)) !== control.subject) throw new GoogleAccountMismatchError();
          const current = await traceStartup('googleCalendar.settings', () => readPersonalGoogleCalendarControl(input.database));
          if (!current.enabled || current.generation !== control.generation || current.subject !== control.subject) throw new GoogleAccountMismatchError();
        };
        const api = input.createApi({ subject: control.subject, assertCurrent: guard, signal: budget.signal });
        const request = async <T>(fn: () => Promise<T>) => { if (++calls > 100) throw new CalendarPassPending(); await guard(); const value = await fn(); await guard(); return value; };
        // Only native identity reads race the deadline; always await SQLite commit/rollback before releasing the queue.
        const transact = <T>(fn: (tx: SQLiteDatabase) => Promise<T>) => withPersonalGoogleCalendar(input.database, control, async tx => {
          if (await withinGoogleOperationBudget(budget, () => input.currentSubject()) !== control.subject) throw new GoogleAccountMismatchError();
          const value = await fn(tx);
          if (await withinGoogleOperationBudget(budget, () => input.currentSubject()) !== control.subject) throw new GoogleAccountMismatchError(); return value;
        });
        const outgoingReserve = Math.min(5_000, Math.ceil(budget.remaining() / 3));
        const canReceive = () => budget.remaining() > outgoingReserve;
        const dirty = async (calendar: GoogleCalendarListEntry) => {
          // Import a bounded batch atomically. Native account checks stay before/after the
          // transaction instead of making a credential bridge round trip for each SQL row.
          const stats = await transact(async tx => {
          const transactInBatch = <T>(work: (connection: SQLiteDatabase) => Promise<T>) => work(tx);
          let imported = 0; let processed = 0; let mutated = false;
          // Masters precede exceptions, even if Google delivered them in reverse page order.
          // Bound the read as well as the writes. Sorting every staged JSON blob
          // in JavaScript made a large first import repeat that work each pass.
          const rows = await transactInBatch(tx => tx.getAllAsync<{ google_id: string; event_json: string }>(`SELECT google_id,event_json FROM calendar_google_inbox
            WHERE subject=? AND calendar_id=? AND dirty IN (1,2)
            ORDER BY dirty,CASE WHEN json_extract(event_json,'$.recurringEventId') IS NULL THEN 0 ELSE 1 END,attempt_order,google_id LIMIT 26`, control.subject, calendar.id));
          let attemptOrder = (await tx.getFirstAsync<{ n: number }>('SELECT coalesce(max(attempt_order),0) n FROM calendar_google_inbox WHERE subject=? AND calendar_id=?', control.subject, calendar.id))!.n;
          for (const row of rows) {
            if (processed >= 25) break;
            if (!canReceive()) return { complete: false, imported, mutated };
            processed++;
            budget.assert(); const remote = JSON.parse(row.event_json) as GoogleCalendarEvent;
            const result = await transactInBatch(tx => receivePersonalGoogleEvent(tx, control, calendar, remote));
            if (result === 'applied') mutated = true;
            if (result === 'waiting') {
              await tx.runAsync('UPDATE calendar_google_inbox SET dirty=2,attempt_order=? WHERE subject=? AND calendar_id=? AND google_id=? AND event_json=?', ++attemptOrder, control.subject, calendar.id, row.google_id, row.event_json);
              continue;
            }
            if (result === 'expand') {
              const parentId = remote.recurringEventId ?? remote.id;
              const source = remote.recurringEventId ? await transactInBatch(tx => tx.getFirstAsync<{ event_json: string }>('SELECT event_json FROM calendar_google_inbox WHERE subject=? AND calendar_id=? AND google_id=?', control.subject, calendar.id, parentId)) : row;
              if (!source) continue;
              const original = JSON.parse(source.event_json) as GoogleCalendarEvent;
              if (!original.recurrence?.length) {
                if (await transactInBatch(tx => receivePersonalGoogleEvent(tx, control, calendar, googleReadOnlyInstance(original), { expanded: true, original })) === 'applied') mutated = true;
              } else await transactInBatch(async tx => {
                const existing = await tx.getFirstAsync<PersonalGoogleLink>('SELECT * FROM calendar_google_links WHERE subject=? AND calendar_id=? AND google_id=?', control.subject, calendar.id, parentId);
                const local = existing && await localGoogleItem(tx, existing.event_id);
                // Do not discard an offline local series edit to adopt an unrepresentable remote RRULE.
                if (existing?.base_json && local && local.revision !== existing.local_revision && googleOwnedFields(personalGoogleBody({ ...local, link: existing })) !== (existing.local_base_json ?? existing.base_json)
                  && !await isLegacyHiddenGoogleParent(tx,existing,local)) {
                  await writePersonalGoogleLink(tx, { ...existing, remote_json: JSON.stringify(original), conflict_json: JSON.stringify({ revision: local.revision, etag: original.etag, remote: googleOwnedFields(original), readOnly: true }) }); return;
                }
                if (local?.value) { await tx.runAsync('UPDATE calendar_events SET deleted=1,revision=revision+1 WHERE id=? AND deleted=0', local.eventId); mutated = true; }
                const hidden = existing && await localGoogleItem(tx, existing.event_id);
                await writePersonalGoogleLink(tx, { subject: control.subject, calendar_id: calendar.id, google_id: parentId,
                  event_id: existing?.event_id ?? `google.${personalGoogleDigest([control.subject, calendar.id, parentId]).slice(0, 48)}`, anchor_date: '', etag: original.etag ?? null,
                  base_json: googleOwnedFields(original), local_revision: hidden?.revision ?? 0,
                  local_base_json: hidden ? googleOwnedFields({ status: 'cancelled' }) : null,
                  remote_json: JSON.stringify(original), conflict_json: null, read_only: 1 });
                const existingRange = await tx.getFirstAsync<{ range_json: string }>('SELECT range_json FROM calendar_google_expansion WHERE subject=? AND calendar_id=? AND parent_id=?', control.subject, calendar.id, parentId);
                const desired = await desiredGoogleExpansionRange(tx, control.subject, input.today());
                const range = existingRange ? mergeGoogleExpansionRanges(desired, JSON.parse(existingRange.range_json)) : desired;
                // A changed master/exception invalidates the previous pagination token.
                await tx.runAsync('INSERT OR REPLACE INTO calendar_google_expansion(subject,calendar_id,parent_id,page_token,range_json,active) VALUES(?,?,?,NULL,?,1)', control.subject, calendar.id, parentId, JSON.stringify(range));
                await tx.runAsync('UPDATE calendar_google_expanded SET seen=0 WHERE subject=? AND calendar_id=? AND parent_id=?', control.subject, calendar.id, parentId);
              });
            }
            await transactInBatch(tx => tx.runAsync('UPDATE calendar_google_inbox SET dirty=0 WHERE subject=? AND calendar_id=? AND google_id=? AND event_json=?', control.subject, calendar.id, row.google_id, row.event_json)); imported++;
          }
          const unreviewed = await tx.getFirstAsync('SELECT 1 FROM calendar_google_inbox WHERE subject=? AND calendar_id=? AND dirty=1 LIMIT 1', control.subject, calendar.id);
          return { complete: !unreviewed, imported, mutated };
          });
          changed ||= stats.mutated; received += stats.imported; return stats.complete;
        };
        try {
          await guard();
          let calendars: GoogleCalendarListEntry[] = options.deltaOnly ? [...control.calendars] : [];
          let calendarPage: string | undefined; const calendarPages = new Set<string>();
          if (!options.deltaOnly) {
            do {
              const page = await request(() => api.calendars(calendarPage));
              for (const calendar of page.items ?? []) if (canReadGoogleCalendar(calendar)) calendars.push(calendar);
              if (calendars.length > 1000 || page.nextPageToken && calendarPages.has(page.nextPageToken)) throw new Error('Googleのカレンダー一覧を確認してください。');
              calendarPage = page.nextPageToken; if (calendarPage) calendarPages.add(calendarPage);
            } while (calendarPage);
            const refreshed = await refreshPersonalGoogleCalendars(input.database, control, calendars);
            control = refreshed.control; changed ||= refreshed.projectionChanged;
            calendars = control.calendars;
          }
          if (options.deltaOnly && !calendars.length) return finish({ kind: 'pending', received, sent });
          const priorProgress = await transact(tx => tx.getFirstAsync<{ remaining_json: string }>('SELECT remaining_json FROM calendar_google_progress WHERE subject=?', control.subject));
          const remaining = priorProgress ? (JSON.parse(priorProgress.remaining_json) as string[]).filter(id => calendars.some(row => row.id === id)) : calendars.map(row => row.id);
          // An empty queue starts another delta pass. A deferred full rebuild of
          // one calendar must not starve the other calendars' valid delta feeds.
          if (!remaining.length || options.deltaOnly) for (const calendar of calendars) if (!remaining.includes(calendar.id)) remaining.push(calendar.id);
          const saveProgress = () => transact(tx => tx.runAsync('INSERT INTO calendar_google_progress(subject,remaining_json) VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET remaining_json=excluded.remaining_json', control.subject, JSON.stringify(remaining)));
          await saveProgress();
          incoming: for (const id of [...remaining]) {
            const calendar = control.calendars.find(row => row.id === id)!;
            // Native SQLite/import work also consumes time. Drain saved progress before another HTTP page.
            if (!await dirty(calendar)) break incoming;
            let complete = false;
            while (!complete) {
              // Reserve room for offline edits even with hundreds of calendars or large pages.
              if (calls >= 75 || !canReceive()) break incoming;
              const cursor = await transact(tx => tx.getFirstAsync<{ sync_token: string | null; page_token: string | null; scan_id: string | null; visited_json: string }>('SELECT * FROM calendar_google_cursors WHERE subject=? AND calendar_id=?', control.subject, calendar.id));
              // Initial traversals and a410 rebuild resume only in foreground.
              // Other calendars with a valid delta token can still make progress.
              if (options.deltaOnly && !cursor?.sync_token) continue incoming;
              const scan = cursor?.sync_token ? null : cursor?.scan_id ?? personalGoogleDigest([now(), random(), calendar.id]);
              let page;
              try { page = await request(() => api.events(calendar.id, { ...(cursor?.sync_token ? { syncToken: cursor.sync_token } : {}), ...(cursor?.page_token ? { pageToken: cursor.page_token } : {}) })); }
              catch (cause) {
                if (!(cause instanceof GoogleCalendarHttpError && cause.status === 410)) throw cause;
                await transact(tx => tx.runAsync('DELETE FROM calendar_google_cursors WHERE subject=? AND calendar_id=?', control.subject, calendar.id)); continue;
              }
              if (!page.nextPageToken && !page.nextSyncToken || page.nextPageToken && page.nextPageToken === cursor?.page_token) throw new Error('Googleの差分位置を確認できません。');
              const visited = advanceCalendarPageHistory(cursor?.visited_json, cursor?.page_token, page.nextPageToken);
              await transact(async tx => {
                const events = (page.items ?? []).map(event => {
                  const json = JSON.stringify(event);
                  if (typeof event.id !== 'string' || !event.id || event.id.length > 1024 || json.length > 500_000) throw new Error('Googleの予定を読み込めません。');
                  return { id: event.id, json };
                });
                for (let offset = 0; offset < events.length; offset += 50) {
                  const batch = events.slice(offset, offset + 50);
                  await tx.runAsync(`INSERT INTO calendar_google_inbox(subject,calendar_id,google_id,event_json,dirty,scan_id) VALUES${batch.map(() => '(?,?,?,?,1,?)').join(',')}
                    ON CONFLICT(subject,calendar_id,google_id) DO UPDATE SET dirty=CASE WHEN event_json<>excluded.event_json THEN 1 ELSE dirty END,event_json=excluded.event_json,scan_id=excluded.scan_id`,
                    ...batch.flatMap(event => [control.subject, calendar.id, event.id, event.json, scan]));
                }
                await tx.runAsync('INSERT OR REPLACE INTO calendar_google_cursors(subject,calendar_id,sync_token,page_token,scan_id,visited_json) VALUES(?,?,?,?,?,?)', control.subject, calendar.id,
                  page.nextPageToken ? cursor?.sync_token ?? null : page.nextSyncToken!, page.nextPageToken ?? null, scan, visited);
                if (!page.nextPageToken && scan) {
                  // Full-rescan deletions are real remote changes; local pending edits still become conflicts.
                  await tx.runAsync(`INSERT INTO calendar_google_inbox(subject,calendar_id,google_id,event_json,dirty,scan_id)
                    SELECT l.subject,l.calendar_id,l.google_id,json_object('id',l.google_id,'status','cancelled'),1,? FROM calendar_google_links l WHERE l.subject=? AND l.calendar_id=? AND l.base_json IS NOT NULL AND l.anchor_date=''
                    AND NOT EXISTS(SELECT 1 FROM calendar_google_expanded x WHERE x.subject=l.subject AND x.calendar_id=l.calendar_id AND x.google_id=l.google_id)
                    AND NOT EXISTS(SELECT 1 FROM calendar_google_inbox i WHERE i.subject=l.subject AND i.calendar_id=l.calendar_id AND i.google_id=l.google_id AND i.scan_id=?)
                    ON CONFLICT(subject,calendar_id,google_id) DO UPDATE SET event_json=excluded.event_json,dirty=1,scan_id=excluded.scan_id`, scan, control.subject, calendar.id, scan);
                }
              });
              if (!await dirty(calendar)) break incoming;
              complete = !page.nextPageToken;
            }
            await transact(async tx => {
              const desired = await desiredGoogleExpansionRange(tx, control.subject, input.today());
              const existing = await tx.getAllAsync<{ parent_id: string; range_json: string }>('SELECT * FROM calendar_google_expansion WHERE subject=? AND calendar_id=? AND active=0', control.subject, calendar.id);
              for (const row of existing) if (!googleRangeContains(JSON.parse(row.range_json), desired)) {
                const link = await tx.getFirstAsync<PersonalGoogleLink>('SELECT * FROM calendar_google_links WHERE subject=? AND calendar_id=? AND google_id=?', control.subject, calendar.id, row.parent_id);
                if (!link?.remote_json || JSON.parse(link.remote_json).status === 'cancelled') continue;
                await tx.runAsync("UPDATE calendar_google_expansion SET page_token=NULL,visited_json='[]',range_json=?,scan_ranges_json=?,active=1 WHERE subject=? AND calendar_id=? AND parent_id=?", JSON.stringify(mergeGoogleExpansionRanges(JSON.parse(row.range_json), desired)), JSON.stringify(missingGoogleExpansionRanges(JSON.parse(row.range_json), desired)), control.subject, calendar.id, row.parent_id);
              }
            });
            // Expansions are resumable and share the same 100-request and wall-clock limits.
            const expansions = await transact(tx => tx.getAllAsync<{ parent_id: string; page_token: string | null; range_json: string; scan_ranges_json: string | null; visited_json: string }>('SELECT * FROM calendar_google_expansion WHERE subject=? AND calendar_id=? AND active=1', control.subject, calendar.id));
            for (const expansion of expansions) {
              let token = expansion.page_token ?? undefined;
              let visited = expansion.visited_json;
              const ranges = expansion.scan_ranges_json ? JSON.parse(expansion.scan_ranges_json) as { timeMin: string; timeMax: string }[] : [JSON.parse(expansion.range_json)];
              while (ranges.length) {
              do {
                if (calls >= 75 || !canReceive()) break incoming;
                const page = await request(() => api.instances(calendar.id, expansion.parent_id, { ...ranges[0], ...(token ? { pageToken: token } : {}) }));
                if (page.nextPageToken && page.nextPageToken === token) throw new Error('Googleの繰り返し予定を読み直してください。');
                const nextVisited = advanceCalendarPageHistory(visited, token, page.nextPageToken);
                await transact(async tx => {
                  for (const event of page.items ?? []) {
                    if (await receivePersonalGoogleEvent(tx, control, calendar, googleReadOnlyInstance(event), { expanded: true, parentId: expansion.parent_id, original: event }) === 'applied') changed = true;
                    await tx.runAsync('UPDATE calendar_google_expanded SET seen=1 WHERE subject=? AND calendar_id=? AND parent_id=? AND google_id=?', control.subject, calendar.id, expansion.parent_id, event.id);
                  }
                  const remainingRanges = page.nextPageToken ? ranges : ranges.slice(1);
                  await tx.runAsync('UPDATE calendar_google_expansion SET page_token=?,active=?,scan_ranges_json=?,visited_json=? WHERE subject=? AND calendar_id=? AND parent_id=?', page.nextPageToken ?? null, page.nextPageToken || remainingRanges.length ? 1 : 0, expansion.scan_ranges_json ? JSON.stringify(remainingRanges) : null, nextVisited, control.subject, calendar.id, expansion.parent_id);
                  if (!page.nextPageToken && !expansion.scan_ranges_json) {
                    const old = await tx.getAllAsync<PersonalGoogleLink>(`SELECT l.* FROM calendar_google_links l JOIN calendar_google_expanded x USING(subject,calendar_id,google_id) WHERE x.subject=? AND x.calendar_id=? AND x.parent_id=? AND x.seen=0`, control.subject, calendar.id, expansion.parent_id);
                    for (const link of old) if (await receivePersonalGoogleEvent(tx, control, calendar, { id: link.google_id, status: 'cancelled' }, { expanded: true }) === 'applied') changed = true;
                  }
                }); token = page.nextPageToken; visited = nextVisited;
              } while (token);
              ranges.shift();
              }
            }
            remaining.splice(remaining.indexOf(calendar.id), 1); await saveProgress();
          }
          if (!remaining.length) await transact(tx => tx.runAsync('DELETE FROM calendar_google_progress WHERE subject=?', control.subject));
          const items = await transact(tx => listPersonalGoogleItems(tx, control));
          localCandidates = items.length;
          for (const item of items) {
            budget.assert(); let body = personalGoogleBody(item); let owned = googleOwnedFields(body);
            if (!item.link?.pending_json && item.link?.local_revision === item.revision) continue;
            if (!item.link?.pending_json && item.link?.local_base_json === owned) {
              // A local category-only edit needs no Google write and no repeated reprocessing next pass.
              await transact(tx => writePersonalGoogleLink(tx, { ...item.link!, local_revision: item.revision })); continue;
            }
            let link = item.link;
            const calendarId = link?.calendar_id ?? control.targetCalendarId!;
            const calendar = control.calendars.find(row => row.id === calendarId);
            if (!calendar || !canWriteGoogleCalendar(calendar)) continue;
            if (item.anchor && !link?.google_id) {
              const parent = await transact(tx => tx.getFirstAsync<PersonalGoogleLink>("SELECT * FROM calendar_google_links WHERE subject=? AND event_id=? AND anchor_date=''", control.subject, item.eventId));
              if (!parent?.etag) continue;
              const series = await transact(tx => localGoogleItem(tx, item.eventId));
              const found = await findGoogleCalendarInstance({ api, request, calendarId, parentId: parent.google_id, anchorDate: item.anchor as LocalDate, series: series?.value });
              if (!found?.etag) throw new Error('Googleの対象回を確認できません。変更は保持しています。');
              link = { ...parent, google_id: found.id, anchor_date: item.anchor, base_json: googleOwnedFields(found), etag: found.etag, remote_json: JSON.stringify(found), local_revision: 0 };
              link.local_base_json = null;
              // The instance can have its own availability. Build the PATCH and
              // its acknowledgement from the resolved instance, not a placeholder.
              body = personalGoogleBody({ ...item, link }); owned = googleOwnedFields(body);
              await transact(tx => writePersonalGoogleLink(tx, link!));
            }
            if (!link) {
              link = { subject: control.subject, calendar_id: calendarId, google_id: `lf${personalGoogleDigest([control.subject, calendarId, item.eventId])}`,
                event_id: item.eventId, anchor_date: '', etag: null, base_json: null, local_revision: 0, remote_json: null, conflict_json: null, read_only: 0 };
              await transact(tx => writePersonalGoogleLink(tx, link!)); // Reserve before HTTP, including a lost acknowledgement.
            }
            const tag = personalGoogleDigest([control.subject, calendarId, item.eventId]);
            const prior = link.remote_json ? JSON.parse(link.remote_json) as GoogleCalendarEvent : null;
            if (!link.pending_json && item.value && !item.anchor && prior?.status === 'cancelled') {
              // Restoring an explicitly chosen local deletion conflict needs a fresh stable ID.
              const previousId = link.google_id;
              link = { ...link, google_id: `lf${personalGoogleDigest([control.subject, calendarId, item.eventId, 'restore', item.revision])}`, etag: null, base_json: null, remote_json: null };
              await transact(tx => tx.runAsync('UPDATE calendar_google_links SET google_id=?,etag=NULL,base_json=NULL,remote_json=NULL WHERE subject=? AND calendar_id=? AND google_id=?', link!.google_id, control.subject, calendarId, previousId));
            }
            let payload: Record<string, unknown> = { ...body, ...(item.value ? { status: 'confirmed' } : {}), extendedProperties: { private: { ...prior?.extendedProperties?.private, liflowPersonal: tag } } };
            const intent: PersonalGoogleWriteIntent = link.pending_json ? JSON.parse(link.pending_json) : { payload, owned, revision: item.revision };
            payload = intent.payload; owned = intent.owned;
            link = { ...link, pending_json: JSON.stringify(intent) };
            await transact(tx => writePersonalGoogleLink(tx, link!));
            let remote: GoogleCalendarEvent;
            try {
              if (payload.status === 'cancelled') {
                if (!link.etag) try {
                  const existing = await request(() => api.get(calendarId, link!.google_id));
                  if (existing.extendedProperties?.private?.liflowPersonal !== tag) throw new Error('Google予定の紐付けを確認してください。'); link.etag = existing.etag ?? null;
                } catch (cause) { if (!(cause instanceof GoogleCalendarHttpError && [404, 410].includes(cause.status))) throw cause; }
                if (link.etag) try { await request(() => api.remove(calendarId, link!.google_id, link!.etag!)); }
                catch (cause) { if (!(cause instanceof GoogleCalendarHttpError && [404, 410].includes(cause.status))) throw cause; }
                remote = { id: link.google_id, status: 'cancelled' };
              } else if (link.etag) remote = await request(() => api.patch(calendarId, link!.google_id, payload, link!.etag!));
              else try { remote = await request(() => api.insert(calendarId, { ...payload, id: link!.google_id })); }
              catch (cause) {
                if (!(cause instanceof GoogleCalendarHttpError && cause.status === 409)) throw cause;
                remote = await request(() => api.get(calendarId, link!.google_id));
                if (remote.extendedProperties?.private?.liflowPersonal !== tag || googleOwnedFields(remote) !== owned) throw new GoogleCalendarHttpError(412);
              }
            } catch (cause) {
              if (!(cause instanceof GoogleCalendarHttpError && [404, 410, 412].includes(cause.status))) throw cause;
              let current: GoogleCalendarEvent;
              try { current = await request(() => api.get(calendarId, link!.google_id)); }
              catch (error) { if (!(error instanceof GoogleCalendarHttpError && [404, 410].includes(error.status))) throw error; current = { id: link!.google_id, status: 'cancelled' }; }
              if (await transact(tx => receivePersonalGoogleEvent(tx, control, calendar, current)) === 'applied') changed = true; continue;
            }
            if (!remote.id || payload.status !== 'cancelled' && !remote.etag) throw new Error('Googleの保存結果を確認できません。');
            const accepted = { ...link!, google_id: remote.id, etag: remote.etag ?? link!.etag,
              base_json: googleOwnedFields(remote), local_base_json: owned, remote_json: JSON.stringify(remote), local_revision: intent.revision, conflict_json: null, pending_json: null };
            await transact(tx => writePersonalGoogleLink(tx, accepted)); sent++;
            if (intent.revision !== item.revision) items.push({ ...item, link: accepted });
          }
          const waiting = await transact(async tx => {
            // An acknowledged master deletion also retires staged exceptions.
            // A pending local deletion or unresolved restoration does not.
            await tx.runAsync(`UPDATE calendar_google_inbox AS i SET dirty=0 WHERE subject=? AND dirty=2 AND EXISTS (
              SELECT 1 FROM calendar_google_links parent JOIN calendar_events e ON e.id=parent.event_id
              WHERE parent.subject=i.subject AND parent.calendar_id=i.calendar_id
                AND parent.google_id=json_extract(i.event_json,'$.recurringEventId') AND e.deleted=1
                AND json_extract(parent.remote_json,'$.status')='cancelled')`, control.subject);
            return tx.getFirstAsync<{ n: number }>(`SELECT count(*) n FROM calendar_google_inbox
              WHERE subject=? AND dirty=2 AND calendar_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`, control.subject, JSON.stringify(control.calendars));
          });
          const waitingCount = waiting?.n ?? 0; const retryAt = waitingCount && !remaining.length ? now() + 60_000 : 0;
          await updatePersonalGoogleCalendarStatus(input.database, control, { ...(!remaining.length && !waitingCount ? { lastSyncAt: new Date(now()).toISOString() } : {}),
            error: waitingCount ? `一部の繰り返し予定を受信待ちです（${waitingCount}件）。` : null, retryAt, retryCount: 0 });
          if (changed) notifyCalendarSyncChanged(input.database);
          return finish({ kind: remaining.length || waitingCount ? 'pending' : 'success', received, sent, ...(waitingCount ? { waiting: waitingCount, ...(retryAt ? { retryAt } : {}) } : {}) });
        } catch (cause) {
          const pending = cause instanceof CalendarPassPending || cause instanceof Error && cause.name === 'AbortError';
          const wait = cause instanceof GoogleCalendarHttpError && cause.retryAfterMs || Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(control.retryCount, 9)) * (.75 + random() * .5);
          try { await updatePersonalGoogleCalendarStatus(input.database, control, { error: pending ? null : cause instanceof Error ? cause.message.slice(0, 1000) : 'Googleカレンダーと同期できません。', retryAt: pending ? 0 : now() + Math.ceil(wait), retryCount: pending ? 0 : control.retryCount + 1 }); }
          catch { /* A disconnected account cannot write status or data into its replacement. */ }
          if (changed) notifyCalendarSyncChanged(input.database); return finish({ kind: pending ? 'pending' : 'error', received, sent });
        }
      }, 'googleCalendar.sync');
    })().finally(() => { budget.close(); if (running === work) { running = null; activeBudget = undefined; } });
    running = work; return work;
  };
  return { sync, prepareConnection, readControl: () => readPersonalGoogleCalendarControl(input.database),
    async requestRange(from: LocalDate, through: LocalDate) {
      const control = await readPersonalGoogleCalendarControl(input.database); if (!control.enabled) return false;
      return withPersonalGoogleCalendar(input.database, control, tx => retainGoogleDisplayRange(tx, control.subject, from, through));
    },
    async readConflicts() {
      const control = await readPersonalGoogleCalendarControl(input.database); if (!control.enabled) return [];
      return withPersonalGoogleCalendar(input.database, control, async tx => {
        const rows = await tx.getAllAsync<PersonalGoogleLink>('SELECT * FROM calendar_google_links WHERE subject=? AND conflict_json IS NOT NULL AND active=1', control.subject);
        return Promise.all(rows.map(async row => { const local = await localGoogleItem(tx, row.event_id, row.anchor_date); return ({ eventId: row.event_id, googleId: row.google_id, calendarId: row.calendar_id,
          version: JSON.stringify({ conflict: row.conflict_json, revision: local?.revision ?? null }),
          local: local?.value ?? null,
          remote: JSON.parse(row.remote_json ?? '{}') as GoogleCalendarEvent,
          canKeepLocal: control.calendars.some(calendar => calendar.id === row.calendar_id && canWriteGoogleCalendar(calendar)) && JSON.parse(row.remote_json ?? '{}').locked !== true }); }));
      });
    },
    async resolveConflict(review: { eventId: string; googleId: string; calendarId: string; version: string }, choice: 'local' | 'google') {
      const control = await readPersonalGoogleCalendarControl(input.database);
      await withPersonalGoogleCalendar(input.database, control, async tx => {
        if (await input.currentSubject() !== control.subject) throw new GoogleAccountMismatchError();
        const link = await tx.getFirstAsync<PersonalGoogleLink>('SELECT * FROM calendar_google_links WHERE subject=? AND calendar_id=? AND google_id=?', control.subject, review.calendarId, review.googleId);
        const reviewed = JSON.parse(review.version);
        if (!link || link.event_id !== review.eventId || !link.conflict_json || link.conflict_json !== reviewed.conflict) throw new Error('予定が再び変更されています。内容を確認してください。');
        const local = await localGoogleItem(tx, link.event_id, link.anchor_date); const conflict = JSON.parse(review.version);
        if (!local || local.revision !== conflict.revision) throw new Error('端末の予定が再び変更されています。内容を確認してください。');
        const calendar = control.calendars.find(row => row.id === link.calendar_id); if (!calendar) throw new Error('Googleの接続先を確認してください。');
        if (choice === 'local' && !canWriteGoogleCalendar(calendar)) throw new Error('このカレンダーはGoogle側で変更してください。');
        const remote = JSON.parse(link.remote_json!) as GoogleCalendarEvent;
        if (choice === 'local' && remote.locked === true) throw new Error('この予定はGoogle側で変更してください。');
        await writePersonalGoogleLink(tx, { ...link, pending_json: null, conflict_json: null, read_only: choice === 'local' ? 0 : link.read_only,
          local_base_json: choice === 'google' ? googleOwnedFields(personalGoogleBody({ ...local, link })) : link.local_base_json,
          base_json: choice === 'local' ? googleOwnedFields(remote) : googleOwnedFields(personalGoogleBody({ ...local, link })), local_revision: 0 });
        if (choice === 'google') await tx.runAsync(`INSERT INTO calendar_google_inbox(subject,calendar_id,google_id,event_json,dirty) VALUES(?,?,?,?,1)
          ON CONFLICT(subject,calendar_id,google_id) DO UPDATE SET event_json=excluded.event_json,dirty=1`, control.subject, calendar.id, remote.id, JSON.stringify(remote));
        if (await input.currentSubject() !== control.subject) throw new GoogleAccountMismatchError();
      });
    },
    async connect(review: Review) {
      const captured = reviews.get(review); if (!captured || await input.currentSubject() !== captured.account.subject) throw new GoogleAccountMismatchError();
      const primary = captured.calendars.find(row => row.primary && canWriteGoogleCalendar(row));
      if (!primary) throw new Error('Googleのメインカレンダーを確認できません。'); activeBudget?.cancel();
      const value = await connectPersonalGoogleCalendar(input.database, captured.generation, captured.account.subject, captured.calendars, primary.id); reviews.delete(review); return value;
    },
    async disable(expected: PersonalGoogleCalendarControl) { activeBudget?.cancel(); return disablePersonalGoogleCalendar(input.database, expected); },
  };
}
export type PersonalGoogleCalendarSync = ReturnType<typeof createPersonalGoogleCalendarSync>;
