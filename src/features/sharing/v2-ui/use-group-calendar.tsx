import { useMemo, useRef, useState } from 'react';
import type { CalendarCategory } from '../../../domain/calendar/events';
import type { CalendarEditorDraft } from '../../../platform/storage/calendar-events';
import { clearSubmittedCalendarDraft, newCalendarSubmissionId, saveCalendarCategory, saveCalendarDraft, saveCalendarEvent, deleteCalendarEvent } from '../../../platform/storage/calendar-events';
import type { LocalCalendarBinding } from '../../calendar/use-local-calendar';
import { projectSharedCalendarRecords } from '../../calendar/shared-events';
import type { SharedCalendarRecord } from '../v2/calendar-state';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2MutationOutcome } from './mutation-outcome';
import { v2CalendarCommandDigest } from '../v2/calendar-actions';
import { captureV2Input } from '../v2/input-capture';

const noCategories: CalendarCategory[] = [];
const proof = (record: SharedCalendarRecord) => JSON.stringify({ series: record.heads.map(op => op.operationId).sort(),
  exceptions: Object.fromEntries(record.exceptions.map(row => [row.anchorDate, row.heads.map(op => op.operationId).sort()])) });

/** A group event is never persisted by the personal event writer, or vice versa. */
export function useGroupCalendar(local: LocalCalendarBinding | undefined, model: V2GroupScreenModel, actions: V2GroupController['actions'],
  perform: ((work: () => Promise<unknown>) => Promise<V2MutationOutcome>) | undefined, groupName: string): LocalCalendarBinding | undefined {
  const groupId = model.plan.groupId;
  const submissions = useRef(new WeakMap<CalendarEditorDraft, { id: string; digest: string }>());
  const cleanupPending = useRef(new Map<string, { database: NonNullable<LocalCalendarBinding['database']>; draft: CalendarEditorDraft }>());
  const [cleanupError, setCleanupError] = useState<{ groupId: string; message: string } | null>(null);
  const [temporary, setTemporary] = useState<{ groupId: string; rows: CalendarCategory[] }>({ groupId, rows: [] });
  const categories = temporary.groupId === groupId ? temporary.rows : noCategories;
  const projected = useMemo(() => projectSharedCalendarRecords(model.calendar ?? [], groupId), [model.calendar, groupId]);
  const personalSnapshot = local?.snapshot;
  const events = useMemo(() => [...(personalSnapshot?.events ?? []), ...projected.events], [personalSnapshot?.events, projected.events]);
  const exceptions = useMemo(() => [...(personalSnapshot?.exceptions ?? []), ...projected.exceptions], [personalSnapshot?.exceptions, projected.exceptions]);
  const snapshot = useMemo(() => {
    if (!personalSnapshot) return undefined;
    const draftCategories = (personalSnapshot.drafts ?? []).filter(draft => draft.audience === 'group' && draft.groupId === groupId).flatMap(draft => draft.editorCategory ? [draft.editorCategory] : []);
    const allCategories = [...new Map([...personalSnapshot.categories, ...projected.groupCategories.values(), ...draftCategories, ...categories].map(category => [category.id, category])).values()];
    const drafts = (personalSnapshot.drafts ?? []).filter(draft => draft.audience !== 'group' || draft.groupId === groupId);
    return { ...personalSnapshot, events, exceptions,
      categories: allCategories, drafts, draft: drafts[0] ?? null };
  }, [personalSnapshot, projected, groupId, categories, events, exceptions]);
  if (!local || !snapshot) return undefined;
  const { recordsById, groupCategories, rawCategories } = projected;
  const allCategories = snapshot.categories;
  const canEdit: NonNullable<LocalCalendarBinding['canEditEvent']> = (id, anchorDate) => {
    const record = recordsById.get(id);
    return record ? record.creatorUserId === model.viewerUserId || model.viewerUserId === model.adminUserId : local.canEditEvent?.(id, anchorDate) !== false;
  };
  const mutate = async (work: () => Promise<unknown>) => {
    if (perform) { const result = await perform(work); if (!result.committed) throw result.error ?? new Error('共有予定を保存できませんでした。'); }
    else await work();
  };
  const assertGroup = (draft: CalendarEditorDraft) => {
    if (!local.database || draft.groupId !== groupId || !model.calendarSupported) throw new Error('グループの管理者が互換更新を行ってから共有予定を追加してください。');
    if (draft.eventId && !canEdit(draft.eventId)) throw new Error('共有予定の作成者または管理者だけが変更できます。');
  };
  const saveGroup = async (draft: CalendarEditorDraft, remove = false, resetExceptions = false) => {
    assertGroup(draft); const record = draft.eventId ? recordsById.get(draft.eventId) : undefined;
    if (draft.eventId && !record) throw new Error('共有予定を読み直してください。');
    const captured = draft.basisRevision ? JSON.parse(draft.basisRevision) : { series: [], exceptions: {} };
    const category = rawCategories.get(draft.value.categoryId) ?? allCategories.find(row => row.id === draft.value.categoryId) ?? draft.editorCategory;
    if (!remove && !category) throw new Error('共有する分類を選んでください。');
    const command = captureV2Input({ eventId: record?.id, basisRevision: record ? JSON.stringify([captured.series, draft.scope === 'series' ? captured.series : captured.exceptions[draft.anchorDate!] ?? []]) : undefined,
        scope: draft.scope, anchorDate: draft.scope === 'series' ? null : draft.anchorDate, value: remove ? null : { ...draft.value, categoryId: category!.id }, category: remove ? null : category!, resetExceptions,
        expectedExceptionIds: Object.values(captured.exceptions as Record<string, string[]>).flat() });
    const digest = v2CalendarCommandDigest(command, { groupId, userId: model.viewerUserId });
    const previous = [draft.submission, submissions.current.get(draft)].find(value => value?.digest === digest);
    const submission = previous ?? { id: newCalendarSubmissionId(), digest };
    submissions.current.set(draft, submission);
    const submitted = captureV2Input({ ...draft, submission, ...(category ? { editorCategory: category } : {}) });
    // Persist retry identity before the separate shared transaction. A restart or
    // missing response can replay this exact command without another event.
    await saveCalendarDraft(local.database!, submitted);
    await mutate(() => actions.saveCalendarEvent({ ...command, intentId: submission.id }));
    const pending = { database: local.database!, draft: submitted };
    cleanupPending.current.set(submission.id, pending);
    try {
      await clearSubmittedCalendarDraft(pending.database, pending.draft); cleanupPending.current.delete(submission.id);
      if (![...cleanupPending.current.values()].some(row => row.draft.groupId === groupId)) setCleanupError(null);
    } catch {
      // The business save is committed. Report cleanup separately, never offer
      // another business write as the cure for a local DELETE failure.
      setCleanupError({ groupId, message: '予定は保存済みです。下書きの整理を完了できませんでした。再読込で再試行できます。' });
    }
  };
  return { ...local, shared: { groupId, name: groupName, enabled: model.calendarSupported === true },
    snapshot, error: cleanupError?.groupId === groupId ? cleanupError.message : local.error,
    async refresh() {
      let failed = false;
      for (const [id, pending] of cleanupPending.current) if (pending.draft.groupId === groupId) {
        try { await clearSubmittedCalendarDraft(pending.database, pending.draft); cleanupPending.current.delete(id); }
        catch { failed = true; }
      }
      setCleanupError(failed ? { groupId, message: '予定は保存済みです。下書きの整理を完了できませんでした。再読込で再試行できます。' } : null);
      await local.refresh();
    },
    categoriesFor: audience => audience === 'personal' ? personalSnapshot!.categories : allCategories,
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
      const submission = submissions.current.get(draft) ?? draft.submission;
      await saveCalendarDraft(local.database, { ...draft, ...(submission ? { submission } : {}), ...(category ? { editorCategory: category } : {}) });
    },
    async saveEvent(draft, resetExceptions) {
      if (draft.audience === 'group') { await saveGroup(draft, false, resetExceptions); return; }
      if (!local.database || recordsById.has(draft.eventId ?? '')) throw new Error('個人予定の保存先を確認してください。');
      await saveCalendarEvent(local.database, { id: draft.eventId ?? undefined, expectedRevision: draft.revision, value: draft.value,
        scope: draft.scope, anchorDate: draft.anchorDate ?? undefined, expectedExceptionRevision: draft.exceptionRevision, resetExceptions });
      void local.refresh();
    },
    async deleteEvent(draft) {
      if (draft.audience === 'group') { await saveGroup(draft, true); return; }
      if (!local.database || !draft.eventId || recordsById.has(draft.eventId)) throw new Error('個人予定の保存先を確認してください。');
      await deleteCalendarEvent(local.database, { id: draft.eventId, expectedRevision: draft.revision,
        anchorDate: draft.scope === 'one' ? draft.anchorDate ?? undefined : undefined, expectedExceptionRevision: draft.exceptionRevision });
      void local.refresh();
    },
    async saveCategory(value, audience = 'personal') {
      if (audience === 'personal') {
        if (!local.database || groupCategories.has(value.id ?? '')) throw new Error('個人の分類を選び直してください。');
        return saveCalendarCategory(local.database, value);
      }
      if (!value.name.trim() || value.name.length > 40 || !/^#[0-9a-f]{6}$/iu.test(value.color)) throw new Error('分類名と色を確認してください。');
      const id = `sharedcat.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
      setTemporary(before => ({ groupId, rows: [...(before.groupId === groupId ? before.rows : []), { id, revision: 1, name: value.name.trim(), color: value.color.toUpperCase() }] })); return id;
    },
  };
}
