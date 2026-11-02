import type { SQLiteDatabase } from 'expo-sqlite';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { LocalDate } from '../../domain/shared/types';
import { addDays } from '../../domain/scheduling/local-date.ts';
import { projectCalendarEvents, validateEventDraft } from '../../domain/calendar/events.ts';
import type { EventDraft } from '../../domain/calendar/events';
import { googleEventBody } from '../../features/calendar/google-event-mapping.ts';
import { GoogleEventExpansionRequired, googleImportedEvent } from '../../features/calendar/google-event-import.ts';
import { googleOwnedFields } from '../../features/calendar/google-owned-fields.ts';
import type { GoogleCalendarEvent, GoogleCalendarListEntry } from '../google-calendar/calendar-api';
import { canWriteGoogleCalendar } from '../google-calendar/calendar-api.ts';
import type { PersonalGoogleCalendarControl } from './personal-google-calendar';

export const personalGoogleDigest = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
export interface PersonalGoogleLink {
  subject: string; calendar_id: string; google_id: string; event_id: string; anchor_date: string;
  etag: string | null; base_json: string | null; local_revision: number; remote_json: string | null;
  conflict_json: string | null; read_only: number; local_base_json?: string | null;
}
export interface PersonalGoogleItem {
  eventId: string; anchor: string; revision: number; value: EventDraft | null; link: PersonalGoogleLink | null;
  inheritedRemoteJson?: string | null;
}
export async function localGoogleItem(tx: SQLiteDatabase, eventId: string, anchor = ''): Promise<PersonalGoogleItem | null> {
  const master = await tx.getFirstAsync<{ definition_json: string; revision: number; deleted: number }>('SELECT * FROM calendar_events WHERE id=?', eventId);
  if (!master) return null;
  const value = validateEventDraft(JSON.parse(master.definition_json));
  if (!anchor) return { eventId, anchor, revision: master.revision, value: master.deleted ? null : value, link: null };
  const instance = await tx.getFirstAsync<{ override_json: string | null; revision: number }>('SELECT * FROM calendar_event_exceptions WHERE event_id=? AND anchor_date=?', eventId, anchor);
  // A structural series edit/reset removes the exception row. Restore this Google instance to the current series body.
  const original = projectCalendarEvents([{ ...value, id: eventId, revision: master.revision }], [], anchor as LocalDate, anchor as LocalDate)[0] ?? null;
  return { eventId, anchor, revision: instance?.revision ?? -master.revision,
    value: master.deleted ? null : instance ? instance.override_json ? validateEventDraft(JSON.parse(instance.override_json)) : null : original, link: null };
}
export function personalGoogleBody(item: PersonalGoogleItem) {
  const value = item.value ? googleEventBody(item.value, Boolean(item.anchor)) : null;
  const source = item.revision < 0 ? item.inheritedRemoteJson ?? item.link?.remote_json : item.link?.remote_json;
  if (value && source && JSON.parse(source).transparency === 'transparent') value.transparency = 'transparent';
  return value ?? { status: 'cancelled' };
}
export async function listPersonalGoogleItems(tx: SQLiteDatabase, control: PersonalGoogleCalendarControl): Promise<PersonalGoogleItem[]> {
  // Select changed revisions in SQLite before parsing definitions or expanding any occurrence.
  const links = await tx.getAllAsync<PersonalGoogleLink & { parent_remote_json: string | null }>(`SELECT l.*,parent.remote_json AS parent_remote_json FROM calendar_google_links l
    JOIN calendar_events e ON e.id=l.event_id
    LEFT JOIN calendar_google_links parent ON parent.subject=l.subject AND parent.event_id=l.event_id AND parent.anchor_date=''
    LEFT JOIN calendar_event_exceptions x ON x.event_id=l.event_id AND x.anchor_date=l.anchor_date
    WHERE l.subject=? AND l.active=1 AND l.read_only=0 AND l.conflict_json IS NULL
      AND (l.anchor_date='' OR e.deleted=0)
      AND l.local_revision <> CASE WHEN l.anchor_date='' THEN e.revision ELSE COALESCE(x.revision,-e.revision) END
    ORDER BY l.event_id,l.anchor_date`, control.subject);
  const result: PersonalGoogleItem[] = [];
  for (const link of links) {
    if (!control.calendars.some(row => row.id === link.calendar_id) || link.read_only || link.conflict_json) continue;
    const item = await localGoogleItem(tx, link.event_id, link.anchor_date); if (item) result.push({ ...item, link,
      ...(item.revision < 0 ? { inheritedRemoteJson: link.parent_remote_json } : {}) });
  }
  // A previous account's imports and mappings must never become new exports for another account.
  const rows = await tx.getAllAsync<{ id: string }>(`SELECT e.id FROM calendar_events e WHERE e.deleted=0
    AND NOT EXISTS(SELECT 1 FROM calendar_google_links l WHERE l.event_id=e.id) ORDER BY e.id LIMIT 10001`);
  if (rows.length > 10000) throw new Error('予定が多すぎます。同期先を確認してください。');
  if (control.targetCalendarId) for (const row of rows) { const item = await localGoogleItem(tx, row.id); if (item) result.push(item); }
  // New exceptions are discovered even if the series itself has not changed.
  const exceptions = await tx.getAllAsync<PersonalGoogleLink & { exception_anchor: string }>(`SELECT l.*,x.anchor_date AS exception_anchor FROM calendar_event_exceptions x
    JOIN calendar_google_links l ON l.event_id=x.event_id AND l.anchor_date='' AND l.subject=?
    JOIN calendar_events e ON e.id=x.event_id
    WHERE e.deleted=0 AND l.active=1 AND l.read_only=0 AND l.conflict_json IS NULL
      AND NOT EXISTS(SELECT 1 FROM calendar_google_links i WHERE i.subject=l.subject AND i.event_id=x.event_id AND i.anchor_date=x.anchor_date)`, control.subject);
  for (const row of exceptions) {
    if (!control.calendars.some(calendar => calendar.id === row.calendar_id)) continue;
    const item = await localGoogleItem(tx, row.event_id, row.exception_anchor); if (item) result.push({ ...item, link: { ...row, anchor_date: row.exception_anchor, google_id: '', local_revision: 0, base_json: null, etag: null, remote_json: null } });
  }
  return result;
}
export async function writePersonalGoogleLink(tx: SQLiteDatabase, link: PersonalGoogleLink) {
  await tx.runAsync(`INSERT INTO calendar_google_links(subject,calendar_id,google_id,event_id,anchor_date,etag,base_json,local_base_json,local_revision,remote_json,conflict_json,read_only)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(subject,calendar_id,google_id) DO UPDATE SET
      event_id=excluded.event_id,anchor_date=excluded.anchor_date,etag=excluded.etag,base_json=excluded.base_json,local_base_json=excluded.local_base_json,local_revision=excluded.local_revision,remote_json=excluded.remote_json,
      conflict_json=excluded.conflict_json,read_only=excluded.read_only,active=1`,
  link.subject, link.calendar_id, link.google_id, link.event_id, link.anchor_date, link.etag, link.base_json, link.local_base_json ?? null, link.local_revision, link.remote_json, link.conflict_json, link.read_only);
}
async function category(tx: SQLiteDatabase, calendar: GoogleCalendarListEntry) {
  const id = `google.${personalGoogleDigest(calendar.id).slice(0, 24)}`;
  // Never rename the user's chosen category while synchronizing.
  await tx.runAsync('INSERT OR IGNORE INTO calendar_categories(id,name,color,revision) VALUES(?,?,?,1)', id,
    (calendar.summary || 'Google').slice(0, 40), /^#[0-9a-f]{6}$/i.test(calendar.backgroundColor ?? '') ? calendar.backgroundColor! : '#348DC2');
  return id;
}
export function googleOriginalDate(remote: GoogleCalendarEvent, timeZone: string): string | null {
  if (remote.originalStartTime?.date) return remote.originalStartTime.date;
  const at = remote.originalStartTime?.dateTime; if (!at || !Number.isFinite(Date.parse(at))) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
/** Full source JSON is retained privately. Unsupported series are expanded by Google's own engine, never rewritten. */
export async function receivePersonalGoogleEvent(tx: SQLiteDatabase, control: PersonalGoogleCalendarControl, calendar: GoogleCalendarListEntry,
  remote: GoogleCalendarEvent, options: { expanded?: boolean; parentId?: string; original?: GoogleCalendarEvent } = {}): Promise<'applied' | 'unchanged' | 'waiting' | 'expand' | 'ignored'> {
  if (!remote.id || remote.id.length > 1024 || remote.extendedProperties?.private?.liflowShared === '1') return 'ignored';
  const known = await tx.getFirstAsync<PersonalGoogleLink>('SELECT * FROM calendar_google_links WHERE subject=? AND calendar_id=? AND google_id=?', control.subject, calendar.id, remote.id);
  let eventId = known?.event_id ?? `google.${personalGoogleDigest([control.subject, calendar.id, remote.id]).slice(0, 48)}`;
  let anchor = known?.anchor_date ?? '';
  let parentLink: PersonalGoogleLink | null = null;
  if (remote.recurringEventId && !options.expanded) {
    const parent = await tx.getFirstAsync<PersonalGoogleLink>('SELECT * FROM calendar_google_links WHERE subject=? AND calendar_id=? AND google_id=?', control.subject, calendar.id, remote.recurringEventId);
    if (!parent) return 'waiting'; if (parent.read_only) return 'expand';
    parentLink = parent;
    const definition = await localGoogleItem(tx, parent.event_id); if (!definition?.value) return 'waiting';
    eventId = parent.event_id; anchor = googleOriginalDate(remote, definition.value.timeZone) ?? anchor; if (!anchor) return 'waiting';
  }
  const local = await localGoogleItem(tx, eventId, anchor);
  const source = options.original ?? remote;
  const remoteBody = googleOwnedFields(source);
  const readOnly = !canWriteGoogleCalendar(calendar) || options.expanded === true || remote.locked === true || remote.eventType === 'birthday'
    || calendar.accessRole === 'writerWithoutPrivateAccess' && remote.visibility === 'private';
  const retireExpanded = async () => {
    await tx.runAsync(`UPDATE calendar_events SET deleted=1,revision=revision+1 WHERE deleted=0 AND id IN (
      SELECT l.event_id FROM calendar_google_links l JOIN calendar_google_expanded x USING(subject,calendar_id,google_id)
      WHERE x.subject=? AND x.calendar_id=? AND x.parent_id=?)`, control.subject, calendar.id, remote.id);
    await tx.runAsync('UPDATE calendar_google_expansion SET active=0 WHERE subject=? AND calendar_id=? AND parent_id=?', control.subject, calendar.id, remote.id);
  };
  if (known?.read_only && !local && remote.status === 'cancelled') {
    await retireExpanded(); await writePersonalGoogleLink(tx, { ...known, base_json: remoteBody, remote_json: JSON.stringify(source), etag: remote.etag ?? known.etag, conflict_json: null }); return 'applied';
  }
  const localBody = local ? googleOwnedFields(personalGoogleBody({ ...local, link: known, inheritedRemoteJson: parentLink?.remote_json })) : null;
  const localChanged = known?.base_json && local && local.revision !== known.local_revision && localBody !== (known.local_base_json ?? known.base_json);
  if (localChanged && remoteBody !== known.base_json && localBody !== remoteBody) {
    await writePersonalGoogleLink(tx, { ...known, etag: remote.etag ?? known.etag, remote_json: JSON.stringify(source), read_only: Number(readOnly),
      conflict_json: JSON.stringify({ revision: local.revision, remote: remoteBody, etag: remote.etag ?? null }) }); return 'applied';
  }
  // A remote edit to attendees/reminders alone must not overwrite a pending local content edit.
  const pending = localChanged && remoteBody === known.base_json;
  let body: EventDraft | null = null;
  if (remote.status !== 'cancelled') {
    try { body = googleImportedEvent(remote, await category(tx, calendar), calendar.timeZone ?? 'UTC', Boolean(anchor) || options.expanded); }
    catch (error) { if (error instanceof GoogleEventExpansionRequired && !options.expanded) return 'expand'; throw error; }
    if (local?.value) body = { ...body, categoryId: local.value.categoryId,
      birthday: local.value.birthday && body.allDay && body.recurrence === 'yearly' && body.startDate === body.endDate };
  }
  let revision = local?.revision ?? 0;
  let modified = Boolean(local && known && known.read_only !== Number(readOnly));
  // Google returns an explicit exception independently of its parent, even if
  // today's visible fields match. Keep that boundary for later series edits.
  const missingInstance = Boolean(anchor && local && local.revision < 0);
  const unchangedProjection = known?.base_json === remoteBody && !localChanged && !missingInstance;
  if (!pending && !unchangedProjection && (localBody !== remoteBody || missingInstance)) {
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
  if (known?.read_only && !readOnly && !options.expanded) await retireExpanded();
  await writePersonalGoogleLink(tx, { subject: control.subject, calendar_id: calendar.id, google_id: remote.id, event_id: eventId, anchor_date: anchor,
    etag: remote.etag ?? known?.etag ?? null, base_json: remoteBody, local_revision: pending ? known!.local_revision : revision,
    local_base_json: pending ? known!.local_base_json : googleOwnedFields(body ? { ...googleEventBody(body, Boolean(anchor)), ...(source.transparency === 'transparent' ? { transparency: 'transparent' } : {}) } : { status: 'cancelled' }),
    remote_json: JSON.stringify(source), conflict_json: null, read_only: readOnly ? 1 : 0 });
  if (options.parentId) await tx.runAsync('INSERT OR REPLACE INTO calendar_google_expanded(subject,calendar_id,parent_id,google_id) VALUES(?,?,?,?)', control.subject, calendar.id, options.parentId, remote.id);
  return modified ? 'applied' : 'unchanged';
}
/** Read-only fallback for seconds/folds/long text. Exact raw Google content stays in the private link. */
export function googleReadOnlyInstance(remote: GoogleCalendarEvent): GoogleCalendarEvent {
  const value = { ...remote, summary: String(remote.summary ?? '').trim().slice(0, 160) || '予定', location: String(remote.location ?? '').slice(0, 300), description: String(remote.description ?? '').slice(0, 4000), eventType: 'default', recurrence: undefined };
  for (const field of ['start', 'end'] as const) {
    const at = remote[field]?.dateTime; if (!at) continue;
    const parsed = Date.parse(at); if (!Number.isFinite(parsed)) throw new Error('Googleの予定日時を確認してください。');
    // Round outwards for display/availability, never export this representation.
    const rounded = (field === 'start' ? Math.floor(parsed / 60000) : Math.ceil(parsed / 60000)) * 60000;
    value[field] = { dateTime: new Date(rounded).toISOString(), timeZone: 'UTC' };
  }
  return value;
}
export function googleExpansionRange(today: LocalDate) { return { timeMin: `${addDays(today, -32)}T00:00:00Z`, timeMax: `${addDays(today, 180)}T00:00:00Z` }; }
