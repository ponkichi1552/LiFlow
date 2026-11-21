import type { SQLiteDatabase } from 'expo-sqlite';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { LocalDate } from '../../domain/shared/types';
import { addDays, daysBetween, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import { validateEventDraft } from '../../domain/calendar/events.ts';
import type { EventDraft } from '../../domain/calendar/events';
import { googleEventBody } from '../../features/calendar/google-event-mapping.ts';
import { GoogleEventExpansionRequired, googleImportedEvent } from '../../features/calendar/google-event-import.ts';
import { googleOwnedFields } from '../../features/calendar/google-owned-fields.ts';
import { googleCalendarInstant, googleSourceTimeZone } from '../../features/calendar/import-formatter.ts';
import type { GoogleCalendarEvent, GoogleCalendarListEntry } from '../google-calendar/calendar-api';
import { canWriteGoogleCalendar } from '../google-calendar/calendar-api.ts';
import type { PersonalGoogleCalendarControl } from './personal-google-calendar';
import { googleOriginalDate, calendarOccurrenceAt } from '../../features/calendar/google-instance.ts';
export { googleOriginalDate } from '../../features/calendar/google-instance.ts';

export const personalGoogleDigest = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
export const personalGoogleCategoryId = (subject: string, calendarId: string) => `google.${personalGoogleDigest([subject, calendarId]).slice(0, 24)}`;
export interface PersonalGoogleLink {
  subject: string; calendar_id: string; google_id: string; event_id: string; anchor_date: string;
  etag: string | null; base_json: string | null; local_revision: number; remote_json: string | null;
  conflict_json: string | null; read_only: number; local_base_json?: string | null; pending_json?: string | null;
}
export interface PersonalGoogleWriteIntent {
  payload: Record<string, unknown>; owned: string; revision: number;
  /** Raw local fields represented by this exact request, independent of its Google title label. */
  localOwned?: string;
}
export interface PersonalGoogleItem {
  eventId: string; anchor: string; revision: number; value: EventDraft | null; link: PersonalGoogleLink | null;
  inheritedRemoteJson?: string | null;
  detached?: boolean;
}
interface StoredGoogleItem { definition_json: string; revision: number; deleted: number; override_json?: string | null; exception_revision?: number | null }
function projectStoredGoogleItem(master: StoredGoogleItem, eventId: string, anchor: string): PersonalGoogleItem {
  const value = validateEventDraft(JSON.parse(master.definition_json));
  if (!anchor) return { eventId, anchor, revision: master.revision, value: master.deleted ? null : value, link: null };
  const hasInstance = master.exception_revision !== null && master.exception_revision !== undefined;
  const override = hasInstance && master.override_json ? JSON.parse(master.override_json) : null;
  const original = !hasInstance && !master.deleted ? calendarOccurrenceAt(value, eventId, anchor as LocalDate) : null;
  return { eventId, anchor, revision: hasInstance ? master.exception_revision! : -master.revision,
    value: master.deleted ? null : hasInstance ? override ? validateEventDraft(override) : null : original, link: null,
    ...(override?._retainedOccurrence === true ? { detached: true } : {}) };
}
/** Old display expansion hid the parent without recording its local baseline.
 * This exact legacy combination cannot be edited through the read-only UI. */
export async function isLegacyHiddenGoogleParent(tx: SQLiteDatabase, link: PersonalGoogleLink | null | undefined, local: PersonalGoogleItem | null) {
  return Boolean(link?.read_only && link.anchor_date === '' && link.local_revision === 0 && !link.local_base_json && !link.pending_json
    && local && local.value === null && await tx.getFirstAsync('SELECT 1 FROM calendar_google_expansion WHERE subject=? AND calendar_id=? AND parent_id=?',link.subject,link.calendar_id,link.google_id));
}
export async function localGoogleItem(tx: SQLiteDatabase, eventId: string, anchor = ''): Promise<PersonalGoogleItem | null> {
  const master = await tx.getFirstAsync<{ definition_json: string; revision: number; deleted: number }>('SELECT * FROM calendar_events WHERE id=?', eventId);
  if (!master) return null;
  if (!anchor) return projectStoredGoogleItem(master, eventId, anchor);
  const instance = await tx.getFirstAsync<{ override_json: string | null; revision: number }>('SELECT * FROM calendar_event_exceptions WHERE event_id=? AND anchor_date=?', eventId, anchor);
  // A structural series edit/reset removes the exception row. Restore this Google instance to the current series body.
  return projectStoredGoogleItem({ ...master, override_json: instance?.override_json, exception_revision: instance?.revision }, eventId, anchor);
}
export function personalGoogleBody(item: PersonalGoogleItem, shortenTitle = false) {
  const value = item.value ? googleEventBody(item.value, Boolean(item.anchor), shortenTitle) : null;
  const source = item.revision < 0 ? item.inheritedRemoteJson ?? item.link?.remote_json : item.link?.remote_json;
  if (value && source && JSON.parse(source).transparency === 'transparent') value.transparency = 'transparent';
  return value ?? { status: 'cancelled' };
}
/** A tombstone keeps its last raw title privately for a later Google undo. */
export function personalGoogleLocalBaseline(owned: string, previous?: string | null): string {
  const value = JSON.parse(owned) as { deleted?: boolean; title?: unknown };
  if (!value.deleted || typeof value.title === 'string' || !previous) return owned;
  const title = (JSON.parse(previous) as { title?: unknown }).title;
  return typeof title === 'string' ? JSON.stringify({ deleted: true, title }) : owned;
}
/** Retained tombstone titles do not represent an outstanding content edit. */
export function personalGoogleComparableBaseline(baseline: string | null | undefined): string | null | undefined {
  return baseline && (JSON.parse(baseline) as { deleted?: boolean }).deleted ? googleOwnedFields({ status: 'cancelled' }) : baseline;
}
/** Restore only a title already represented by this link or a matching title proof. */
function personalGoogleOriginalTitle(remote: GoogleCalendarEvent, localTitle: string | undefined, known: PersonalGoogleLink | null | undefined, parent: PersonalGoogleLink | null): string | undefined {
  if (localTitle === undefined || remote.status === 'cancelled') return undefined;
  const title = (json: string | null | undefined) => json ? (JSON.parse(json) as { title?: unknown }).title : undefined;
  const previousTitle = title(known?.base_json) ?? title(parent?.base_json);
  const originalTitle = title(known?.local_base_json) ?? title(parent?.local_base_json);
  const marker = remote.extendedProperties?.private;
  const ownTitleLabel = marker?.liflowPersonal && marker.liflowTitleProof === personalGoogleDigest([localTitle, remote.summary ?? '']);
  const previousTitleLabel = typeof originalTitle === 'string' && marker?.liflowPersonal
    && marker.liflowTitleProof === personalGoogleDigest([originalTitle, remote.summary ?? '']);
  if (remote.summary === previousTitle || previousTitleLabel) return typeof originalTitle === 'string' ? originalTitle : localTitle;
  return ownTitleLabel ? localTitle : undefined;
}
export async function listPersonalGoogleItems(tx: SQLiteDatabase, control: PersonalGoogleCalendarControl): Promise<PersonalGoogleItem[]> {
  const calendarIds = new Set(control.calendars.map(calendar => calendar.id));
  // Select changed revisions in SQLite before parsing definitions or expanding any occurrence.
  const links = await tx.getAllAsync<PersonalGoogleLink & StoredGoogleItem & { parent_remote_json: string | null }>(`SELECT l.*,parent.remote_json AS parent_remote_json,
    e.definition_json,e.revision,e.deleted,x.override_json,x.revision AS exception_revision FROM calendar_google_links l
    JOIN calendar_events e ON e.id=l.event_id
    LEFT JOIN calendar_google_links parent ON parent.subject=l.subject AND parent.event_id=l.event_id AND parent.anchor_date=''
    LEFT JOIN calendar_event_exceptions x ON x.event_id=l.event_id AND x.anchor_date=l.anchor_date
    WHERE l.subject=? AND l.active=1 AND l.read_only=0 AND l.conflict_json IS NULL
      AND (l.anchor_date='' OR e.deleted=0)
      AND (l.pending_json IS NOT NULL OR l.local_revision <> CASE WHEN l.anchor_date='' THEN e.revision ELSE COALESCE(x.revision,-e.revision) END)
    ORDER BY l.event_id,l.anchor_date`, control.subject);
  const result: PersonalGoogleItem[] = [];
  for (const link of links) {
    if (!calendarIds.has(link.calendar_id) || link.read_only || link.conflict_json) continue;
    const item = projectStoredGoogleItem(link, link.event_id, link.anchor_date); result.push({ ...item, link,
      ...(item.revision < 0 ? { inheritedRemoteJson: link.parent_remote_json } : {}) });
  }
  // A previous account's imports and mappings must never become new exports for another account.
  if (control.targetCalendarId) {
  const rows = await tx.getAllAsync<StoredGoogleItem & { id: string }>(`SELECT e.id,e.definition_json,e.revision,e.deleted FROM calendar_events e WHERE e.deleted=0
    AND NOT EXISTS(SELECT 1 FROM calendar_google_links l WHERE l.event_id=e.id) ORDER BY e.id LIMIT 10001`);
  if (rows.length > 10000) throw new Error('予定が多すぎます。同期先を確認してください。');
  for (const row of rows) result.push(projectStoredGoogleItem(row, row.id, ''));
  }
  // New exceptions are discovered even if the series itself has not changed.
  const exceptions = await tx.getAllAsync<PersonalGoogleLink & StoredGoogleItem & { exception_anchor: string }>(`SELECT l.*,x.anchor_date AS exception_anchor,
    e.definition_json,e.revision,e.deleted,x.override_json,x.revision AS exception_revision FROM calendar_event_exceptions x
    JOIN calendar_google_links l ON l.event_id=x.event_id AND l.anchor_date='' AND l.subject=?
    JOIN calendar_events e ON e.id=x.event_id
    WHERE e.deleted=0 AND l.active=1 AND l.read_only=0 AND l.conflict_json IS NULL
      AND NOT EXISTS(SELECT 1 FROM calendar_google_links i WHERE i.subject=l.subject AND i.event_id=x.event_id AND i.anchor_date=x.anchor_date)`, control.subject);
  for (const row of exceptions) {
    if (!calendarIds.has(row.calendar_id)) continue;
    const item = projectStoredGoogleItem(row, row.event_id, row.exception_anchor); result.push({ ...item,
      link: { ...row, anchor_date: row.exception_anchor, google_id: '', local_revision: 0, base_json: null, etag: null, remote_json: null,
        pending_json: null, local_base_json: null } });
  }
  return result;
}
export async function writePersonalGoogleLink(tx: SQLiteDatabase, link: PersonalGoogleLink, previous?: PersonalGoogleLink | null) {
  const fields = ['subject','calendar_id','google_id','event_id','anchor_date','etag','base_json','local_base_json','local_revision','remote_json','conflict_json','read_only','pending_json'] as const;
  if (previous && 'active' in previous && previous.active === 1 && fields.every(field => (previous[field] ?? null) === (link[field] ?? null))) return;
  await tx.runAsync(`INSERT INTO calendar_google_links(subject,calendar_id,google_id,event_id,anchor_date,etag,base_json,local_base_json,local_revision,remote_json,conflict_json,read_only,pending_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(subject,calendar_id,google_id) DO UPDATE SET
      event_id=excluded.event_id,anchor_date=excluded.anchor_date,etag=excluded.etag,base_json=excluded.base_json,local_base_json=excluded.local_base_json,local_revision=excluded.local_revision,remote_json=excluded.remote_json,
      conflict_json=excluded.conflict_json,read_only=excluded.read_only,pending_json=excluded.pending_json,active=1`,
  link.subject, link.calendar_id, link.google_id, link.event_id, link.anchor_date, link.etag, link.base_json, link.local_base_json ?? null, link.local_revision, link.remote_json, link.conflict_json, link.read_only, link.pending_json ?? null);
}
async function category(tx: SQLiteDatabase, control: PersonalGoogleCalendarControl, calendar: GoogleCalendarListEntry) {
  const prior = await tx.getFirstAsync<{ category_id: string }>(`SELECT json_extract(e.definition_json,'$.categoryId') AS category_id
    FROM calendar_google_links l JOIN calendar_events e ON e.id=l.event_id
    WHERE l.subject=? AND l.calendar_id=? AND l.active=1 AND e.deleted=0 AND json_extract(e.definition_json,'$.categoryId') LIKE 'google.%'
    ORDER BY l.event_id LIMIT 1`, control.subject, calendar.id);
  // Keep an older category attached to its original account, but give a newly
  // connected account a separate category row for the same Google calendar ID.
  const id = prior?.category_id ?? personalGoogleCategoryId(control.subject, calendar.id);
  // Never rename the user's chosen category while synchronizing.
  await tx.runAsync('INSERT OR IGNORE INTO calendar_categories(id,name,color,revision) VALUES(?,?,?,1)', id,
    (calendar.summary || 'Google').slice(0, 40), /^#[0-9a-f]{6}$/i.test(calendar.backgroundColor ?? '') ? calendar.backgroundColor! : '#348DC2');
  return id;
}
/** Full source JSON is retained privately. Unsupported series are expanded by Google's own engine, never rewritten. */
export async function receivePersonalGoogleEvent(tx: SQLiteDatabase, control: PersonalGoogleCalendarControl, calendar: GoogleCalendarListEntry,
  remote: GoogleCalendarEvent, options: { expanded?: boolean; parentId?: string; original?: GoogleCalendarEvent; missingFromSnapshot?: boolean } = {}): Promise<'applied' | 'unchanged' | 'waiting' | 'expand' | 'ignored'> {
  if (!remote.id || remote.id.length > 1024 || remote.extendedProperties?.private?.liflowShared === '1') return 'ignored';
  let known = await tx.getFirstAsync<PersonalGoogleLink>('SELECT * FROM calendar_google_links WHERE subject=? AND calendar_id=? AND google_id=?', control.subject, calendar.id, remote.id);
  const source = options.original ?? remote;
  if (known?.remote_json) {
    const previous = Date.parse(JSON.parse(known.remote_json).updated);
    const incoming = typeof source.updated === 'string' ? Date.parse(source.updated) : NaN;
    if (Number.isFinite(previous) && Number.isFinite(incoming) && incoming < previous) return 'unchanged';
  }
  let eventId = known?.event_id ?? `google.${personalGoogleDigest([control.subject, calendar.id, remote.id]).slice(0, 48)}`;
  let anchor = known?.anchor_date ?? '';
  if (options.expanded && anchor) {
    eventId = `google.${personalGoogleDigest([control.subject, calendar.id, remote.id]).slice(0, 48)}`;
    anchor = '';
  }
  let parentLink: PersonalGoogleLink | null = null;
  if (remote.recurringEventId && !options.expanded) {
    const parent = await tx.getFirstAsync<PersonalGoogleLink>('SELECT * FROM calendar_google_links WHERE subject=? AND calendar_id=? AND google_id=?', control.subject, calendar.id, remote.recurringEventId);
    if (!parent) {
      const staged = await tx.getFirstAsync<{ event_json: string }>('SELECT event_json FROM calendar_google_inbox WHERE subject=? AND calendar_id=? AND google_id=?', control.subject, calendar.id, remote.recurringEventId);
      return staged && JSON.parse(staged.event_json).status === 'cancelled' ? 'ignored' : 'waiting';
    }
    if (parent.read_only && await tx.getFirstAsync('SELECT 1 FROM calendar_google_expansion WHERE subject=? AND calendar_id=? AND parent_id=?', control.subject, calendar.id, parent.google_id)) return 'expand';
    parentLink = parent;
    const definition = await localGoogleItem(tx, parent.event_id);
    if (!definition?.value) return parent.remote_json && JSON.parse(parent.remote_json).status === 'cancelled' ? 'ignored' : 'waiting';
    eventId = parent.event_id; anchor = googleOriginalDate(remote, definition.value.timeZone) ?? anchor; if (!anchor) return 'waiting';
  }
  const local = await localGoogleItem(tx, eventId, anchor);
  const remoteBody = googleOwnedFields(source);
  const readOnly = !canWriteGoogleCalendar(calendar) || options.expanded === true || remote.locked === true || remote.eventType === 'birthday'
    || calendar.accessRole === 'writerWithoutPrivateAccess' && remote.visibility === 'private';
  const sourceZone = (event: Pick<GoogleCalendarEvent, 'start'> | null | undefined) => googleSourceTimeZone(event, calendar.timeZone);
  const remoteZone = sourceZone(remote);
  let savedZone = sourceZone(known?.remote_json ? JSON.parse(known.remote_json) as GoogleCalendarEvent : null);
  if (known?.pending_json && local) {
    const intent = JSON.parse(known.pending_json) as PersonalGoogleWriteIntent;
    const marker = (intent.payload.extendedProperties as GoogleCalendarEvent['extendedProperties'])?.private?.liflowPersonal;
    if (remoteBody === intent.owned && (remote.status === 'cancelled' || marker && source.extendedProperties?.private?.liflowPersonal === marker
      && remoteZone === sourceZone(intent.payload))) {
      // This is evidence for the exact request that was sent, not for a later edit.
      // Preserve that later revision until it has its own Google acknowledgement.
      known = { ...known, base_json: remoteBody, local_base_json: personalGoogleLocalBaseline(intent.localOwned ?? intent.owned, known.local_base_json), local_revision: intent.revision,
        etag: remote.etag ?? known.etag, remote_json: JSON.stringify(source), pending_json: null };
      savedZone = remoteZone;
      await writePersonalGoogleLink(tx, known);
    } else if (remoteBody === known.base_json && remoteZone === savedZone) return 'unchanged';
    else {
      await writePersonalGoogleLink(tx, { ...known, etag: remote.etag ?? known.etag, remote_json: JSON.stringify(source),
        conflict_json: JSON.stringify({ revision: local.revision, remote: remoteBody, etag: remote.etag ?? null }) });
      return 'applied';
    }
  }
  if (options.missingFromSnapshot) {
    if (!known) return 'ignored';
    const localBody = local ? googleOwnedFields(personalGoogleBody({ ...local, link: known })) : null;
    const pending = known.pending_json ? JSON.parse(known.pending_json) as PersonalGoogleWriteIntent : null;
    const localChanged = pending ? pending.owned !== googleOwnedFields({ status: 'cancelled' }) : Boolean(known.base_json && local
      && local.revision !== known.local_revision
      && localBody !== personalGoogleComparableBaseline(known.local_base_json ?? known.base_json)
      && !await isLegacyHiddenGoogleParent(tx, known, local));
    const cancelled = JSON.stringify({ id: remote.id, status: 'cancelled' });
    if (localChanged) {
      const remoteOwned = googleOwnedFields({ status: 'cancelled' });
      await writePersonalGoogleLink(tx, { ...known, remote_json: cancelled,
        conflict_json: JSON.stringify({ revision: local?.revision ?? pending?.revision ?? null, remote: remoteOwned, etag: null }) });
    } else {
      await tx.runAsync('DELETE FROM calendar_event_exceptions WHERE event_id=? AND anchor_date=?', known.event_id, known.anchor_date);
      await tx.runAsync('UPDATE calendar_google_links SET active=0,remote_json=?,conflict_json=NULL,pending_json=NULL WHERE subject=? AND calendar_id=? AND google_id=?',
        cancelled, control.subject, calendar.id, known.google_id);
    }
    return 'applied';
  }
  const retireExpanded = async () => {
    await tx.runAsync(`UPDATE calendar_events SET deleted=1,revision=revision+1 WHERE deleted=0 AND id IN (
      SELECT l.event_id FROM calendar_google_links l JOIN calendar_google_expanded x USING(subject,calendar_id,google_id)
      WHERE x.subject=? AND x.calendar_id=? AND x.parent_id=?)`, control.subject, calendar.id, remote.id);
    await tx.runAsync(`UPDATE calendar_google_links SET active=0 WHERE subject=? AND calendar_id=? AND google_id IN
      (SELECT google_id FROM calendar_google_expanded WHERE subject=? AND calendar_id=? AND parent_id=?)`, control.subject, calendar.id, control.subject, calendar.id, remote.id);
    // Retired display projections are distinct from a completed, resumable scan.
    await tx.runAsync('DELETE FROM calendar_google_expansion WHERE subject=? AND calendar_id=? AND parent_id=?', control.subject, calendar.id, remote.id);
    await tx.runAsync('DELETE FROM calendar_google_expansion_staged WHERE subject=? AND calendar_id=? AND parent_id=?', control.subject, calendar.id, remote.id);
  };
  if (known?.read_only && !local && remote.status === 'cancelled') {
    await retireExpanded(); await writePersonalGoogleLink(tx, { ...known, base_json: remoteBody, remote_json: JSON.stringify(source), etag: remote.etag ?? known.etag, conflict_json: null }); return 'applied';
  }
  const localBody = local ? googleOwnedFields(personalGoogleBody({ ...local, link: known, inheritedRemoteJson: parentLink?.remote_json })) : null;
  // A Google undo can restore a tombstone. Its original local definition is
  // still stored, even though it is absent from the visible event projection.
  const retained = local && !local.value && remote.status !== 'cancelled'
    ? await tx.getFirstAsync<{ definition_json: string }>('SELECT definition_json FROM calendar_events WHERE id=?', eventId) : null;
  const localTitle = local?.value?.title ?? (retained ? validateEventDraft(JSON.parse(retained.definition_json)).title : undefined);
  // Compare the same raw representation on both sides before declaring a
  // conflict. Independently converged edits must not conflict just on a label.
  const originalTitle = personalGoogleOriginalTitle(source, localTitle, known, parentLink);
  const comparableRemoteBody = originalTitle === undefined ? remoteBody : googleOwnedFields({ ...source, summary: originalTitle });
  const localChanged = Boolean(known?.base_json && local && local.revision !== known.local_revision && localBody !== personalGoogleComparableBaseline(known.local_base_json ?? known.base_json)
    && !await isLegacyHiddenGoogleParent(tx,known,local));
  const priorZone = savedZone ?? local?.value?.timeZone;
  const explicitZoneChange = !options.expanded && remoteZone !== undefined && priorZone !== undefined && remoteZone !== priorZone;
  if (known && local && localChanged && (remoteBody !== known.base_json || explicitZoneChange)
    && (localBody !== comparableRemoteBody || explicitZoneChange && remoteZone !== local.value?.timeZone)) {
    await writePersonalGoogleLink(tx, { ...known, etag: remote.etag ?? known.etag, remote_json: JSON.stringify(source), read_only: Number(readOnly),
      conflict_json: JSON.stringify({ revision: local.revision, remote: remoteBody, etag: remote.etag ?? null }) }); return 'applied';
  }
  // A remote edit to attendees/reminders alone must not overwrite a pending local content edit.
  const pending = localChanged && remoteBody === known?.base_json && !explicitZoneChange;
  let body: EventDraft | null = null;
  if (remote.status !== 'cancelled') {
    try { body = googleImportedEvent(remote, local?.value?.categoryId ?? await category(tx, control, calendar), calendar.timeZone ?? 'UTC', Boolean(anchor) || options.expanded); }
    catch (error) { if (error instanceof GoogleEventExpansionRequired && !options.expanded) return 'expand'; throw error; }
    if (local?.value) body = { ...body, categoryId: local.value.categoryId,
      birthday: local.value.birthday && body.allDay && body.recurrence === 'yearly' && body.startDate === body.endDate };
    // A manual Google rename no longer matches the stored label or proof.
    if (originalTitle !== undefined) body.title = originalTitle;
  }
  let revision = local?.revision ?? 0;
  let modified = Boolean(local && known && known.read_only !== Number(readOnly));
  // Google returns an explicit exception independently of its parent, even if
  // today's visible fields match. Keep that boundary for later series edits.
  const missingInstance = Boolean(anchor && local && local.revision < 0);
  const projectionMoved = known && (known.event_id !== eventId || known.anchor_date !== anchor);
  const acceptedGoogleConflict = known?.base_json === null && known.local_revision === local?.revision;
  const zoneProjectionChanged = body && local?.value && (explicitZoneChange || acceptedGoogleConflict) && body.timeZone !== local.value.timeZone;
  const unchangedProjection = local && known?.base_json === remoteBody && !localChanged && !missingInstance && !projectionMoved && !zoneProjectionChanged;
  if (!pending && !unchangedProjection && (localBody !== comparableRemoteBody || missingInstance || zoneProjectionChanged)) {
    if (!body && !local) return 'ignored';
    modified = true;
    if (anchor) {
      revision = Math.max(0, revision) + 1;
      await tx.runAsync(`INSERT INTO calendar_event_exceptions(event_id,anchor_date,override_json,revision) VALUES(?,?,?,?)
        ON CONFLICT(event_id,anchor_date) DO UPDATE SET override_json=excluded.override_json,revision=excluded.revision`, eventId, anchor, body ? JSON.stringify(body) : null, revision);
    } else {
      revision++;
      await tx.runAsync(`INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET definition_json=excluded.definition_json,revision=excluded.revision,deleted=excluded.deleted`,
      eventId, JSON.stringify(body ?? local!.value ?? validateEventDraft(JSON.parse((await tx.getFirstAsync<{ definition_json: string }>('SELECT definition_json FROM calendar_events WHERE id=?', eventId))!.definition_json))), revision, body ? 0 : 1);
    }
  }
  // Expansion always records a read-only parent. New/ordinary writable imports
  // have no expanded projections to retire.
  if (known?.read_only && !options.expanded && !anchor && !pending) await retireExpanded();
  await writePersonalGoogleLink(tx, { subject: control.subject, calendar_id: calendar.id, google_id: remote.id, event_id: eventId, anchor_date: anchor,
    etag: remote.etag ?? known?.etag ?? null, base_json: remoteBody, local_revision: pending ? known!.local_revision : revision,
    local_base_json: pending ? known!.local_base_json : personalGoogleLocalBaseline(googleOwnedFields(body ? { ...googleEventBody(body, Boolean(anchor)), ...(source.transparency === 'transparent' ? { transparency: 'transparent' } : {}) } : { status: 'cancelled' }), known?.local_base_json ?? localBody),
    remote_json: JSON.stringify(source), conflict_json: null, read_only: readOnly ? 1 : 0 }, known);
  if (options.parentId) await tx.runAsync('INSERT OR REPLACE INTO calendar_google_expanded(subject,calendar_id,parent_id,google_id) VALUES(?,?,?,?)', control.subject, calendar.id, options.parentId, remote.id);
  return modified ? 'applied' : 'unchanged';
}
/** Read-only fallback for seconds/folds/long text. Exact raw Google content stays in the private link. */
export function googleReadOnlyInstance(remote: GoogleCalendarEvent, fallbackZone = 'UTC'): GoogleCalendarEvent {
  const value = { ...remote, summary: String(remote.summary ?? '').trim().slice(0, 160) || '予定', location: String(remote.location ?? '').slice(0, 300), description: String(remote.description ?? '').slice(0, 4000), eventType: 'default', recurrence: undefined };
  // EventDraft intentionally limits editable spans. Keep a bounded private row
  // for storage while calendar-event-rows restores the exact all-day end date
  // from remote_json when it builds a read-only projection.
  if (remote.start?.date && remote.end?.date) {
    const start = remote.start.date as LocalDate; const end = remote.end.date as LocalDate;
    parseLocalDate(start); parseLocalDate(end);
    if (end > start && daysBetween(start, end) > 367) value.end = { date: addDays(start, 367) };
  }
  for (const field of ['start', 'end'] as const) {
    if (!remote[field]?.dateTime) continue;
    const parsed = googleCalendarInstant(remote[field], fallbackZone); if (!Number.isFinite(parsed)) throw new GoogleEventExpansionRequired('Googleの予定日時を確認してください。');
    // Round outwards for display/availability, never export this representation.
    const rounded = (field === 'start' ? Math.floor(parsed / 60000) : Math.ceil(parsed / 60000)) * 60000;
    value[field] = { dateTime: new Date(rounded).toISOString(), timeZone: 'UTC' };
  }
  if (value.start?.dateTime && value.end?.dateTime) {
    const start = value.start.dateTime.slice(0, 10) as LocalDate; const end = value.end.dateTime.slice(0, 10) as LocalDate;
    if (daysBetween(start, end) > 366) value.end = { dateTime: `${addDays(start, 366)}${value.end.dateTime.slice(10)}`, timeZone: 'UTC' };
  }
  return value;
}
export function googleExpansionRange(today: LocalDate) { return { timeMin: `${addDays(today, -32)}T00:00:00Z`, timeMax: `${addDays(today, 180)}T00:00:00Z` }; }
