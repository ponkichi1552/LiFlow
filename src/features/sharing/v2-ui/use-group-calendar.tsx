import { useState } from 'react';
import type { CalendarCategory, CalendarEvent, CalendarException } from '../../../domain/calendar/events';
import type { CalendarEditorDraft } from '../../../platform/storage/calendar-events';
import { clearCalendarEditorDraft, saveCalendarCategory, saveCalendarDraft, saveCalendarEvent, deleteCalendarEvent } from '../../../platform/storage/calendar-events';
import type { LocalCalendarBinding } from '../../calendar/use-local-calendar';
import { sharedDocumentDigest } from '../crypto';
import { sharedCalendarPayload } from '../v2/calendar-state';
import type { SharedCalendarRecord } from '../v2/calendar-state';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2MutationOutcome } from './mutation-outcome';

const eventId = (group: string, id: string) => `group.${sharedDocumentDigest([group, id])}`;
const categoryId = (group: string, category: { id: string; name: string; color: string }) => `gcat.${sharedDocumentDigest([group, category])}`;
const proof = (record: SharedCalendarRecord) => JSON.stringify({ series: record.heads.map(op => op.operationId).sort(),
  exceptions: Object.fromEntries(record.exceptions.map(row => [row.anchorDate, row.heads.map(op => op.operationId).sort()])) });

/** A group event is never persisted by the personal event writer, or vice versa. */
export function useGroupCalendar(local: LocalCalendarBinding | undefined, model: V2GroupScreenModel, actions: V2GroupController['actions'],
  perform: ((work: () => Promise<unknown>) => Promise<V2MutationOutcome>) | undefined, groupName: string): LocalCalendarBinding | undefined {
  const [categories, setCategories] = useState<CalendarCategory[]>([]);
  if (!local) return undefined;
  const records = model.calendar ?? []; const groupId = model.plan.groupId;
  const recordsById = new Map(records.map(row => [eventId(groupId, row.id), row]));
  const groupCategories = new Map<string, CalendarCategory>(); const rawCategories = new Map<string, CalendarCategory>();
  const events: CalendarEvent[] = []; const exceptions: CalendarException[] = [];
  for (const record of records) {
    if (record.heads.length !== 1) continue;
    const payload = sharedCalendarPayload(record.heads[0]); if (!payload.value || !payload.category) continue;
    const id = eventId(groupId, record.id);
    const category = (value: NonNullable<typeof payload.category>) => {
      const result = { ...value, id: categoryId(groupId, value), revision: 1 };
      groupCategories.set(result.id, result); rawCategories.set(result.id, { ...value, revision: 1 }); return result.id;
    };
    events.push({ ...payload.value, categoryId: category(payload.category), id, revision: record.heads[0].logicalClock });
    for (const row of record.exceptions) {
      const candidate = row.heads.length === 1 ? sharedCalendarPayload(row.heads[0]) : null;
      exceptions.push({ eventId: id, anchorDate: row.anchorDate, revision: Math.max(...row.heads.map(op => op.logicalClock)),
        override: candidate?.value && candidate.category ? { ...candidate.value, categoryId: category(candidate.category) } : null });
    }
  }
  const draftCategories = (local.snapshot.drafts ?? []).filter(draft => draft.audience === 'group' && draft.groupId === groupId).flatMap(draft => draft.editorCategory ? [draft.editorCategory] : []);
  const allCategories = [...new Map([...local.snapshot.categories, ...groupCategories.values(), ...draftCategories, ...categories].map(category => [category.id, category])).values()];
  const drafts = (local.snapshot.drafts ?? []).filter(draft => draft.audience !== 'group' || draft.groupId === groupId);
  const canEdit = (id: string) => {
    const record = recordsById.get(id);
    return record ? record.creatorUserId === model.viewerUserId || model.viewerUserId === model.adminUserId : local.canEditEvent?.(id) !== false;
  };
  const mutate = async (work: () => Promise<unknown>) => {
    if (perform) { const result = await perform(work); if (!result.committed) throw result.error ?? new Error('共有予定を保存できませんでした。'); }
    else await work();
  };
  const assertGroup = (draft: CalendarEditorDraft) => {
    if (!local.database || draft.groupId !== groupId || !model.calendarSupported) throw new Error('グループの所有者が互換更新を行ってから共有予定を追加してください。');
    if (draft.eventId && !canEdit(draft.eventId)) throw new Error('共有予定の作成者または管理者だけが変更できます。');
  };
  const saveGroup = async (draft: CalendarEditorDraft, remove = false, resetExceptions = false) => {
    assertGroup(draft); const record = draft.eventId ? recordsById.get(draft.eventId) : undefined;
    if (draft.eventId && !record) throw new Error('共有予定を読み直してください。');
    const captured = draft.basisRevision ? JSON.parse(draft.basisRevision) : { series: [], exceptions: {} };
    const category = rawCategories.get(draft.value.categoryId) ?? allCategories.find(row => row.id === draft.value.categoryId) ?? draft.editorCategory;
    if (!remove && !category) throw new Error('共有する分類を選んでください。');
    await mutate(async () => {
      await actions.saveCalendarEvent({ eventId: record?.id, basisRevision: record ? JSON.stringify([captured.series, draft.scope === 'series' ? captured.series : captured.exceptions[draft.anchorDate!] ?? []]) : undefined,
        scope: draft.scope, anchorDate: draft.scope === 'series' ? null : draft.anchorDate, value: remove ? null : { ...draft.value, categoryId: category!.id }, category: remove ? null : category!, resetExceptions });
      await clearCalendarEditorDraft(local.database!, draft);
    });
  };
  return { ...local, shared: { groupId, name: groupName, enabled: model.calendarSupported === true },
    snapshot: { ...local.snapshot, events: [...local.snapshot.events, ...events], exceptions: [...local.snapshot.exceptions, ...exceptions],
      categories: allCategories, drafts, draft: drafts[0] ?? null },
    canEditEvent: canEdit,
    prepareDraft(draft) {
      if (!draft.eventId || draft.audience === 'group') return draft;
      const record = recordsById.get(draft.eventId);
      return record ? { ...draft, audience: 'group', groupId, basisRevision: proof(record) } : draft;
    },
    async persistDraft(draft) {
      if (!local.database) throw new Error('入力途中の予定を保存できません。');
      if (draft.audience === 'group') assertGroup(draft);
      const category = allCategories.find(row => row.id === draft.value.categoryId) ?? draft.editorCategory;
      await saveCalendarDraft(local.database, { ...draft, ...(category ? { editorCategory: category } : {}) });
    },
    async saveEvent(draft, resetExceptions) {
      if (draft.audience === 'group') { await saveGroup(draft, false, resetExceptions); return; }
      if (!local.database || recordsById.has(draft.eventId ?? '')) throw new Error('個人予定の保存先を確認してください。');
      await saveCalendarEvent(local.database, { id: draft.eventId ?? undefined, expectedRevision: draft.revision, value: draft.value,
        scope: draft.scope, anchorDate: draft.anchorDate ?? undefined, expectedExceptionRevision: draft.exceptionRevision, resetExceptions });
      await local.refresh();
    },
    async deleteEvent(draft) {
      if (draft.audience === 'group') { await saveGroup(draft, true); return; }
      if (!local.database || !draft.eventId || recordsById.has(draft.eventId)) throw new Error('個人予定の保存先を確認してください。');
      await deleteCalendarEvent(local.database, { id: draft.eventId, expectedRevision: draft.revision,
        anchorDate: draft.scope === 'one' ? draft.anchorDate ?? undefined : undefined, expectedExceptionRevision: draft.exceptionRevision });
      await local.refresh();
    },
    async saveCategory(value, audience = 'personal') {
      if (audience === 'personal') {
        if (!local.database || groupCategories.has(value.id ?? '')) throw new Error('個人の分類を選び直してください。');
        return saveCalendarCategory(local.database, value);
      }
      if (!value.name.trim() || value.name.length > 40 || !/^#[0-9a-f]{6}$/iu.test(value.color)) throw new Error('分類名と色を確認してください。');
      const id = `sharedcat.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
      setCategories(rows => [...rows, { id, revision: 1, name: value.name.trim(), color: value.color.toUpperCase() }]); return id;
    },
  };
}
