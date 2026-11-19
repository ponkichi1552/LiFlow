import { useMemo, useRef, useState } from 'react';
import type { CalendarCategory } from '../../../domain/calendar/events';
import type { CalendarDraftCleanup, CalendarEditorDraft, CalendarFutureSave } from '../../../platform/storage/calendar-events';
import { calendarDraftKey, clearSubmittedCalendarDrafts, newCalendarSubmissionId, saveCalendarCategory, saveCalendarDraft, saveCalendarEvent, saveCalendarFutureEvent, deleteCalendarEvent, restoreCalendarOccurrence } from '../../../platform/storage/calendar-events';
import type { LocalCalendarBinding } from '../../calendar/use-local-calendar';
import { calendarReminderScope, saveCalendarReminder, forkCalendarReminders, rebaseSharedCalendarReminders } from '../../../platform/storage/calendar-reminders';
import { projectSharedCalendarRecords, sharedCalendarEventId } from '../../calendar/shared-events';
import type { SharedCalendarRecord } from '../v2/calendar-state';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2MutationOutcome } from './mutation-outcome';
import { v2CalendarCommandDigest } from '../v2/calendar-actions';
import { calendarFutureUndoCommand } from '../v2/calendar-future-actions';
import { sharedCalendarPayload } from '../v2/calendar-state';
import { captureV2Input } from '../v2/input-capture';
import { canReadCalendarDraft, useCalendarDraftAccess } from '../../calendar/use-calendar-draft-access';
import { calendarReminderUndoProof } from '../../calendar/shared-recovery';

const noCategories: CalendarCategory[] = [];
const proof = (record: SharedCalendarRecord) => JSON.stringify({ series: record.heads.map(op => op.operationId).sort(),
  exceptions: Object.fromEntries(record.exceptions.map(row => [row.anchorDate, row.heads.map(op => op.operationId).sort()])) });

/** A group event is never persisted by the personal event writer, or vice versa. */
export function useGroupCalendar(local: LocalCalendarBinding | undefined, model: V2GroupScreenModel, actions: V2GroupController['actions'],
  perform: ((work: () => Promise<unknown>) => Promise<V2MutationOutcome>) | undefined, groupName: string): LocalCalendarBinding | undefined {
  const groupId = model.plan.groupId;
  const ownerScope = useMemo(() => calendarReminderScope(model.viewerUserId, groupId), [model.viewerUserId, groupId]);
  const assertScope = useCalendarDraftAccess(groupId, ownerScope);
  const submissions = useRef(new WeakMap<CalendarEditorDraft, { id: string; digest: string }>());
  const cleanupPending = useRef(new Map<string, { database: NonNullable<LocalCalendarBinding['database']>; ownerScope: string; snapshots: CalendarDraftCleanup['snapshots'] }>());
  const [cleanupError, setCleanupError] = useState<{ ownerScope: string; message: string } | null>(null);
  const [temporary, setTemporary] = useState<{ ownerScope: string; rows: CalendarCategory[] }>({ ownerScope, rows: [] });
  const accountMatches = local?.draftOwnerScope === undefined || local.draftOwnerScope === ownerScope;
  const categories = accountMatches && temporary.ownerScope === ownerScope ? temporary.rows : noCategories;
  const projected = useMemo(() => projectSharedCalendarRecords(model.calendar ?? [], groupId), [model.calendar, groupId]);
  const personalSnapshot = local?.snapshot;
  const events = useMemo(() => [...(personalSnapshot?.events ?? []), ...projected.events], [personalSnapshot?.events, projected.events]);
  const exceptions = useMemo(() => [...(personalSnapshot?.exceptions ?? []), ...projected.exceptions], [personalSnapshot?.exceptions, projected.exceptions]);
  const snapshot = useMemo(() => {
    if (!personalSnapshot) return undefined;
    const drafts = (personalSnapshot.drafts ?? (personalSnapshot.draft ? [personalSnapshot.draft] : [])).filter(draft => canReadCalendarDraft(draft, groupId, accountMatches ? ownerScope : undefined));
    const draftCategories = drafts.flatMap(draft => draft.audience === 'group' && draft.editorCategory ? [draft.editorCategory] : []);
    const allCategories = [...new Map([...personalSnapshot.categories, ...projected.groupCategories.values(), ...draftCategories, ...categories].map(category => [category.id, category])).values()];
    return { ...personalSnapshot, events, exceptions,
      categories: allCategories, drafts, draft: drafts[0] ?? null };
  }, [personalSnapshot, projected, groupId, ownerScope, accountMatches, categories, events, exceptions]);
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
  const assertDraftAccess = (draft: CalendarEditorDraft) => {
    assertScope(draft); local.assertDraftAccess?.(draft);
  };
  const assertGroup = (draft: CalendarEditorDraft) => {
    assertDraftAccess(draft);
    if (!local.database || draft.groupId !== groupId || !model.calendarSupported) throw new Error('グループの管理者が互換更新を行ってから共有予定を追加してください。');
    if (draft.eventId && !canEdit(draft.eventId)) throw new Error('共有予定の作成者または管理者だけが変更できます。');
  };
  const saveGroup = async (draft: CalendarEditorDraft, remove = false, resetExceptions = false, draftCleanup?: CalendarDraftCleanup) => {
    assertGroup(draft); const record = draft.eventId ? recordsById.get(draft.eventId) : undefined;
    if (draft.eventId && !record) throw new Error('共有予定を読み直してください。');
    if (remove && draft.scope === 'future') throw new Error('削除する範囲を選び直してください。');
    const captured = draft.basisRevision ? JSON.parse(draft.basisRevision) : { series: [], exceptions: {} };
    const category = rawCategories.get(draft.value.categoryId) ?? allCategories.find(row => row.id === draft.value.categoryId) ?? draft.editorCategory;
    if (!remove && !category) throw new Error('共有する分類を選んでください。');
    const command = captureV2Input({ eventId: record?.id, basisRevision: record ? JSON.stringify([captured.series, draft.scope !== 'one' ? captured.series : captured.exceptions[draft.anchorDate!] ?? []]) : undefined,
        scope: draft.scope, anchorDate: draft.scope === 'series' ? null : draft.anchorDate, value: remove ? null : { ...draft.value, categoryId: category!.id }, category: remove ? null : category!, resetExceptions,
        expectedExceptionIds: Object.values(captured.exceptions as Record<string, string[]>).flat() });
    const digest = v2CalendarCommandDigest(command, { groupId, userId: model.viewerUserId });
    const previous = [draft.submission, submissions.current.get(draft)].find(value => value?.digest === digest);
    const submission = previous ?? { id: newCalendarSubmissionId(), digest };
    submissions.current.set(draft, submission);
    const submitted = captureV2Input({ ...draft, submission, ...(category ? { editorCategory: category } : {}) });
    // Persist retry identity before the separate shared transaction. A restart or
    // missing response can replay this exact command without another event.
    await saveCalendarDraft(local.database!, submitted, false, assertDraftAccess);
    let savedId = record?.id; let undoCommand: ReturnType<typeof calendarFutureUndoCommand> = null; let futureReceipt: CalendarFutureSave | undefined;
    await mutate(async () => {
      assertGroup(draft);
      const operations = await actions.saveCalendarEvent({ ...command, intentId: submission.id });
      if (draft.scope === 'future' && record) undoCommand = calendarFutureUndoCommand(record, operations, newCalendarSubmissionId());
      savedId = String(operations.calendarEventId ?? operations[0]?.payload.eventId ?? savedId ?? '');
    });
    if (draft.scope === 'future' && record && savedId && draft.anchorDate) {
      // A replay can see the old series already shortened or deleted by this split.
      const basisId: string = captured.series[0], head = record.heads.find(row => row.operationId === basisId);
      const original = head ? sharedCalendarPayload(head).value : await actions.readCalendarFutureSource(record.id, basisId);
      if (!original) throw new Error('共有予定を読み直してください。');
      assertDraftAccess(draft);
      const notification = await forkCalendarReminders(local.database!, { scope: ownerScope, sourceId: draft.eventId!, branchId: sharedCalendarEventId(groupId, savedId), source: { ...original, id: record.id, revision: 1 }, anchor: draft.anchorDate, next: draft.value, minutes: draft.reminderMinutes });
      const capturedUndo = undoCommand;
      if (capturedUndo) {
        let undone = false;
        futureReceipt = { async undoFuture() {
          if (undone) return;
          assertGroup(draft);
          await mutate(() => notification.undo(() => { assertGroup(draft); return actions.undoCalendarFutureEvent(capturedUndo); },
            calendarReminderUndoProof(capturedUndo, draft.eventId!)));
          undone = true;
          await local.refresh();
        } };
      }
    } else if (!remove) {
      if (draft.scope === 'series' && record && draft.eventId && !resetExceptions && command.value && captured.series.length === 1) {
        const basisId: string = captured.series[0];
        const head = record.heads.find(row => row.operationId === basisId);
        const original = head ? sharedCalendarPayload(head).value : await actions.readCalendarFutureSource(record.id, basisId);
        if (!original) throw new Error('共有予定を読み直してください。');
        await rebaseSharedCalendarReminders(local.database!, {
          scope: ownerScope, intentId: submission.id, source: { ...original, id: draft.eventId, revision: draft.revision },
          next: { ...command.value, id: draft.eventId, revision: draft.revision + 1 }, assertCurrent: () => assertDraftAccess(draft),
        });
      }
      if (draft.reminderMinutes !== undefined) {
        if (!savedId) throw new Error('予定は保存済みです。通知の保存を再試行してください。');
        assertDraftAccess(draft);
        await saveCalendarReminder(local.database!, { scope: ownerScope, eventId: sharedCalendarEventId(groupId, savedId),
          anchorDate: draft.scope === 'one' ? draft.anchorDate : null, minutes: draft.reminderMinutes });
      }
    }
    const submittedKey = calendarDraftKey(submitted);
    const snapshots = [submitted, ...(draftCleanup?.snapshots.filter(row => calendarDraftKey(row) !== submittedKey) ?? [])];
    const pending = { database: local.database!, ownerScope, snapshots };
    cleanupPending.current.set(submission.id, pending);
    try {
      await clearSubmittedCalendarDrafts(pending.database, { snapshots, assertAccess: assertDraftAccess }); cleanupPending.current.delete(submission.id);
      if (![...cleanupPending.current.values()].some(row => row.ownerScope === ownerScope)) setCleanupError(null);
    } catch {
      // The business save is committed. Report cleanup separately, never offer
      // another business write as the cure for a local DELETE failure.
      setCleanupError({ ownerScope, message: '予定は保存済みです。下書きの整理を完了できませんでした。再読込で再試行できます。' });
    }
    return futureReceipt;
  };
  return { ...local, shared: { groupId, name: groupName, notificationScope: ownerScope, enabled: accountMatches && model.calendarSupported === true },
    snapshot, assertDraftAccess, error: cleanupError?.ownerScope === ownerScope ? cleanupError.message : local.error,
    async refresh() {
      let failed = false;
      for (const [id, pending] of cleanupPending.current) if (pending.ownerScope === ownerScope) {
        try { await clearSubmittedCalendarDrafts(pending.database, { snapshots: pending.snapshots, assertAccess: assertDraftAccess }); cleanupPending.current.delete(id); }
        catch { failed = true; }
      }
      setCleanupError(failed ? { ownerScope, message: '予定は保存済みです。下書きの整理を完了できませんでした。再読込で再試行できます。' } : null);
      await local.refresh();
    },
    categoriesFor: audience => audience === 'personal' ? personalSnapshot!.categories : allCategories,
    canEditEvent: canEdit,
    prepareDraft(draft) {
      if (draft.audience === 'group') { assertDraftAccess(draft); return draft; }
      if (!draft.eventId) return draft;
      const record = recordsById.get(draft.eventId);
      return record ? { ...draft, audience: 'group', groupId, ownerScope, basisRevision: proof(record) } : draft;
    },
    async persistDraft(draft) {
      if (!local.database) throw new Error('入力途中の予定を保存できません。');
      if (draft.audience === 'group') assertGroup(draft);
      const category = allCategories.find(row => row.id === draft.value.categoryId) ?? draft.editorCategory;
      const submission = submissions.current.get(draft) ?? draft.submission;
      const stored = { ...draft, ...(submission ? { submission } : {}), ...(category ? { editorCategory: category } : {}) };
      await saveCalendarDraft(local.database, stored, false, assertDraftAccess);
      return stored;
    },
    async saveEvent(draft, resetExceptions, draftCleanup) {
      if (draft.audience === 'group') return saveGroup(draft, false, resetExceptions, draftCleanup);
      if (!local.database || recordsById.has(draft.eventId ?? '')) throw new Error('個人予定の保存先を確認してください。');
      if (draft.scope === 'future') { const result = await saveCalendarFutureEvent(local.database, draft, draftCleanup); void local.refresh(); return result; }
      await saveCalendarEvent(local.database, { id: draft.eventId ?? undefined, draftId: draft.draftId, expectedRevision: draft.revision, value: draft.value,
        scope: draft.scope, anchorDate: draft.anchorDate ?? undefined, expectedExceptionRevision: draft.exceptionRevision, resetExceptions, reminderMinutes: draft.reminderMinutes, draftCleanup });
      void local.refresh();
    },
    async restoreOccurrence(draft) {
      if (draft.audience === 'group') {
        assertGroup(draft); const record = recordsById.get(draft.eventId ?? '');
        if (!record || !draft.anchorDate || !draft.basisRevision) throw new Error('共有予定を読み直してください。');
        const captured = JSON.parse(draft.basisRevision);
        await mutate(() => { assertGroup(draft); return actions.restoreCalendarOccurrence({ eventId: record.id, scope: 'one', anchorDate: draft.anchorDate,
          basisRevision: JSON.stringify([captured.series, captured.exceptions[draft.anchorDate!] ?? []]), value: null, category: null }); });
      } else {
        if (!local.database || recordsById.has(draft.eventId ?? '')) throw new Error('個人予定の保存先を確認してください。');
        await restoreCalendarOccurrence(local.database, draft);
      }
      await local.refresh();
    },
    async deleteEvent(draft) {
      if (draft.scope === 'future') throw new Error('削除する範囲を選び直してください。');
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
      setTemporary(before => ({ ownerScope, rows: [...(before.ownerScope === ownerScope ? before.rows : []), { id, revision: 1, name: value.name.trim(), color: value.color.toUpperCase() }] })); return id;
    },
  };
}
