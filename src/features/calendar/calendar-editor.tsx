import { useContext } from 'react';
import { WorkspaceContext } from '../../contexts/workspace-context';
import { useCalendarReminders } from './use-calendar-reminders';
import { CalendarReminderField } from './calendar-reminder-field';
import { calendarReminderMinutes, calendarReminderScope, saveCalendarReminder } from '../../platform/storage/calendar-reminders';
import { router } from 'expo-router';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { TextInputProps } from 'react-native';
import { Alert, Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme, useWindowDimensions } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import { FormTextInput } from '../../components/form-text-input';
import { SettingsCheckbox } from '../../components/settings-checkbox';
import { SettingsAction, SettingsSegments } from '../../components/settings-controls';
import { Chevron } from '../../components/chevron';
import { addDays, formatJapaneseDate } from '../../domain/scheduling/local-date';
import { CATEGORY_PRESETS, RECURRENCE_LABELS, UNCATEGORIZED_CALENDAR_CATEGORY, isCalendarAnchor, minuteLabel, recurrenceLabel, newAppointmentValue, newEventDraft, validateEventDraft } from './events';
import { calendarDisplayColor as categoryColor } from './event-appearance';
import type { CalendarEvent, CalendarException, CalendarRecurrence, EventDraft } from './events';
import { createCalendarGesture } from './gesture-control';
import { CalendarField } from './calendar-field';
import type { LocalCalendarBinding } from './use-local-calendar';
import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';
import { calendarDraftKey, clearCalendarEditorDraft, saveCalendarFutureEvent, deleteCalendarEvent, discardCalendarDraftIfUnchanged, readLocalCalendarEventSource, saveCalendarCategory, saveCalendarDraft, saveCalendarEvent } from '../../platform/storage/calendar-events';
import { CALENDAR_EDIT_SCOPES, CalendarRecurrenceScopePicker, type CalendarEditScope } from './calendar-recurrence-scope';
import { CalendarOptionPicker } from './calendar-option-picker';
import { moveCalendarStart } from './event-editing';
import { privateCalendarReadOnlySource } from './private-event-projection';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { CalendarSheetContent, CalendarSheetHeader, type CalendarSheetForm } from './calendar-sheet-header';
import type { CalendarChoreInput } from './chore-registration-input';
import { createEditorDraftSession } from './editor-draft-session';
import { calendarDraftScopeValue, changeCalendarDraftScope, duplicateCalendarDraft, rebaseCalendarEventInput } from './direct-actions';
import { createTitleDateTimeInput } from './title-datetime';
import { pinnedClockAt } from '../../domain/scheduling/zoned-clock';
import { rebasedCalendarExceptionDate } from '../../domain/calendar/exception-slots';
import { v2WallTimeCandidates } from '../sharing/v2/local-time';

export interface ExistingCalendarChore { id: string; name: string; minutes?: number; onOpen: () => void }
export type CalendarChoreRegistrationProps = { date: EventDraft['startDate']; initialValue?: EventDraft; initialInput?: CalendarChoreInput; audience?: 'personal' | 'group';
  onAudienceChange?(audience: 'personal' | 'group', input: CalendarChoreInput): void; onBack(audience?: 'personal' | 'group'): void; onCancel?(): void; onClose(): void;
  onSaved(date: EventDraft['startDate'], notice?: string): void; onBusyChange(busy: boolean): void; onInputChange?(hasInput: boolean): void };
export function CalendarEditor({ initial, local, chores = [], onClose, onSaved, onDuplicate, repeatReturnTo = 'personal', renderChoreRegistration, displayTimeZone, choreForm, onChooseChore, onChoreAudience, onClearChore, onChoreInputChange, hiddenForChore = false, onPreviewChore }: {
  initial: CalendarEditorDraft; local: LocalCalendarBinding; chores?: readonly ExistingCalendarChore[]; onClose: () => void; onSaved: (date: EventDraft['startDate'], notice?: string) => void;
  repeatReturnTo?: 'personal' | 'group';
  onDuplicate?(draft: CalendarEditorDraft): void;
  renderChoreRegistration?(props: CalendarChoreRegistrationProps): ReactNode;
  displayTimeZone?: string;
  hiddenForChore?: boolean; onPreviewChore?(open: () => void): void;
  choreForm?: CalendarSheetForm; onChooseChore?(): void; onChoreAudience?(audience: 'personal' | 'group'): void; onClearChore?(): void;
  onChoreInputChange?(hasInput: boolean): void;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const { fontScale } = useWindowDimensions();
  const labelWidths = useMemo(() => ({ date: { width: Math.ceil(36 * Math.max(1, fontScale)) }, option: { width: Math.ceil(76 * Math.max(1, fontScale)) } }), [fontScale]);
  const reminderSettings = useCalendarReminders(local.database); const reminderWorkspace = useContext(WorkspaceContext);
  const [draft, setDraft] = useState(initial); const latest = useRef(draft);
  const editedScopeFields = useRef(new Set<keyof EventDraft>());
  const [titleDateTime] = useState(() => createTitleDateTimeInput(initial.value, timeZone => pinnedClockAt(new Date(), timeZone).date));
  const [openedStoredDraft] = useState(() => (local.snapshot.drafts ?? (local.snapshot.draft ? [local.snapshot.draft] : []))
    .some(row => calendarDraftKey(row) === calendarDraftKey(initial)));
  const [draftSession] = useState(() => createEditorDraftSession(openedStoredDraft ? initial : undefined, local.assertDraftAccess));
  const [storedDrafts, setStoredDrafts] = useState(() => new Set(openedStoredDraft ? [calendarDraftKey(initial)] : []));
  useLayoutEffect(() => { latest.current = draft; }, [draft]);
  const [ownBusy, setBusy] = useState(false); const busy = ownBusy || Boolean(choreForm?.busy); const lock = useRef(false); const scrollTop = useRef(0);
  const externalEntry = choreForm?.entry?.value;
  useLayoutEffect(() => {
    if (!externalEntry || JSON.stringify(latest.current.value) === JSON.stringify(externalEntry)) return;
    const next = { ...latest.current, value: externalEntry }; latest.current = next; setDraft(next);
  }, [externalEntry]);
  const [inputRevision, setInputRevision] = useState(0);
  const [modalRevision, setModalRevision] = useState(0);
  const [exitActions, setExitActions] = useState(false);
  const [registeringChore, setRegisteringChore] = useState(false);
  const [choreInput, setChoreInput] = useState<CalendarChoreInput>();
  const [choreHasInput, setChoreHasInput] = useState(false);
  const carriedChoreInput = useRef(false);
  const appointmentBeforeChore = useRef<CalendarEditorDraft | null>(null);
  const choreDiscardOpen = useRef(false);
  const updateChoreInput = useCallback((hasInput: boolean) => setChoreHasInput(hasInput || carriedChoreInput.current), []);
  const embeddedHasInput = Boolean(choreForm?.hasInput);
  useLayoutEffect(() => { onChoreInputChange?.(embeddedHasInput); }, [onChoreInputChange, embeddedHasInput]);
  const clearChoreEntry = () => {
    setRegisteringChore(false);
    setChoreInput(undefined);
    setChoreHasInput(false);
    carriedChoreInput.current = false;
    appointmentBeforeChore.current = null;
  };
  const [exitBaseline, setExitBaseline] = useState(initial.value);
  const [choreBusy, setChoreBusy] = useState(false); const choreLock = useRef(false);
  const onChoreBusyChange = useCallback((value: boolean) => { choreLock.current = value; setChoreBusy(value); }, []);
  const [ownDetailsOpen, setDetailsOpen] = useState(false); const detailsOpen = choreForm?.entry?.detailsExpanded ?? ownDetailsOpen;
  const [error, setError] = useState<string | null>(null); const [repeatOpen, setRepeatOpen] = useState(false); const [scopeOpen, setScopeOpen] = useState(false); const [categoryOpen, setCategoryOpen] = useState(false); const scheme = useColorScheme();
  type EventBasis = { series?: CalendarEvent; exception?: CalendarException };
  const [basis, setBasis] = useState<EventBasis>(() => ({
    series: local.snapshot.events.find(event => event.id === initial.eventId && event.revision === initial.revision),
    exception: local.snapshot.exceptions.find(row => row.eventId === initial.eventId && row.anchorDate === initial.anchorDate && row.revision === initial.exceptionRevision),
  }));
  const [canReloadEvent, setCanReloadEvent] = useState(false);
  const [review, setReview] = useState<{ basis: EventBasis; values: ReturnType<typeof rebaseCalendarEventInput> } | null>(null);
  const [mergeNotice, setMergeNotice] = useState(false);
  type CategoryEdit = { id?: string; revision: number; name: string; color: string } | null;
  const [categoryEdit, setCategoryEditState] = useState<CategoryEdit>(null);
  const latestCategory = useRef(categoryEdit);
  const setCategoryEdit = (next: CategoryEdit | ((previous: CategoryEdit) => CategoryEdit)) => {
    const current = typeof next === 'function' ? next(latestCategory.current) : next;
    latestCategory.current = current; setCategoryEditState(current);
  };
  const [custom, setCustom] = useState(false); const [rgb, setRgbState] = useState(['52', '141', '194']);
  const latestRgb = useRef(rgb);
  const setRgb = (next: string[]) => { latestRgb.current = next; setRgbState(next); };
  const original = basis.series ?? local.snapshot.events.find(event => event.id === initial.eventId);
  const googleReadOnly = initial.eventId ? privateCalendarReadOnlySource(local.snapshot, initial.eventId, draft.scope === 'one' ? draft.anchorDate : null) : undefined;
  const readOnly = Boolean(initial.eventId && local.canEditEvent?.(initial.eventId, draft.scope === 'one' ? draft.anchorDate : null) === false);
  const reminderScope = draft.audience === 'group' ? local.shared?.notificationScope ?? (reminderWorkspace?.userId ? calendarReminderScope(reminderWorkspace.userId, draft.groupId) : '') : 'personal';
  const reminderMinutes = draft.reminderMinutes !== undefined ? draft.reminderMinutes : calendarReminderMinutes(reminderSettings.settings, reminderScope, draft.eventId, draft.scope === 'one' ? draft.anchorDate : null);
  const reminderUnavailable = reminderSettings.loading || Boolean(reminderSettings.error) || !reminderScope;
  const repeated = original && original.recurrence !== 'none'; const value = draft.value;
  const change = (fn: (before: CalendarEditorDraft) => CalendarEditorDraft) => { const next = fn(latest.current); latest.current = next; setDraft(next); setExitActions(false); choreForm?.entry?.onChange(next.value); };
  const patch = (patch: Partial<EventDraft>) => change(before => ({ ...before, value: { ...before.value, ...patch } }));
  const work = async (task: () => Promise<void>) => {
    if (lock.current) return false; lock.current = true; setBusy(true); setError(null);
    try { await task(); return true; } catch (cause) {
      if (cause instanceof Error && cause.name === 'CalendarEventConflictError' && latest.current.eventId && latest.current.audience !== 'group') setCanReloadEvent(true);
      setError(cause instanceof Error ? cause.message : '保存できませんでした。もう一度お試しください。'); return false;
    }
    finally { lock.current = false; setBusy(false); }
  };
  const hasInput = (current: CalendarEditorDraft) => Boolean(current.value.title.trim() || current.value.location.trim() || current.value.notes.trim());
  const hasChanges = (current: CalendarEditorDraft, checkAudience = true) => JSON.stringify(current.value) !== JSON.stringify(exitBaseline)
    || checkAudience && (current.audience ?? 'personal') !== (initial.audience ?? 'personal')
    || current.scope !== initial.scope || current.reminderMinutes !== initial.reminderMinutes;
  const emptyLegacyDraft = !initial.draftId && !initial.eventId && initial.audience !== 'group' && initial.reminderMinutes === undefined
    && JSON.stringify(initial.value) === JSON.stringify(newEventDraft(initial.value.startDate, initial.value.timeZone, initial.value.birthday));
  const shouldChooseExit = (current: CalendarEditorDraft, checkAudience = true) => !readOnly
    && (hasChanges(current, checkAudience) || (!emptyLegacyDraft && storedDrafts.has(calendarDraftKey(current))));
  const needsExitChoice = shouldChooseExit(draft);
  const persistDraft = async (current: CalendarEditorDraft) => {
    if (!local.database) throw new Error('入力内容の保存先を確認してください。');
    if (current.audience === 'group' && !local.persistDraft) throw new Error('共有予定の保存先を確認してください。');
    const stored = local.persistDraft ? await local.persistDraft(current) : await saveCalendarDraft(local.database, current, false, local.assertDraftAccess);
    local.assertDraftAccess?.(current);
    draftSession.remember(stored ?? current);
    setStoredDrafts(previous => new Set(previous).add(calendarDraftKey(stored ?? current)));
  };
  const discardAndClose = () => void work(async () => { if (local.database) { await clearCalendarEditorDraft(local.database, draftSession.snapshot(initial) ?? initial, local.assertDraftAccess); await draftSession.clear(local.database); } onClose(); });
  const saveDraftAndClose = () => void work(async () => {
    if (!local.database) throw new Error('入力内容の保存先を確認してください。');
    await persistDraft(latest.current); await draftSession.clear(local.database, latest.current); onClose();
  });
  const close = (nativeDismissed = false, checkAudience = true) => {
    if (lock.current || choreLock.current) return;
    if (choreForm) { if (!choreForm.busy) onClose(); return; }
    if (shouldChooseExit(latest.current, checkAudience)) { setExitActions(true); if (nativeDismissed) setModalRevision(v => v + 1); return; }
    if (emptyLegacyDraft && draftSession.snapshot(latest.current)) { discardAndClose(); return; }
    onClose();
  };
  const requestCloseChore = (nativeDismissed = false) => {
    if (lock.current || choreLock.current || choreDiscardOpen.current) return;
    const leave = () => {
      if (lock.current || choreLock.current) return;
      const before = appointmentBeforeChore.current;
      if (before) { latest.current = before; setDraft(before); }
      clearChoreEntry();
      close(nativeDismissed, false);
    };
    if (!choreHasInput) { leave(); return; }
    choreDiscardOpen.current = true;
    Alert.alert('家事の入力を破棄しますか？', undefined, [
      { text: '入力を続ける', style: 'cancel', onPress: () => { choreDiscardOpen.current = false; } },
      { text: '破棄', style: 'destructive', onPress: () => { choreDiscardOpen.current = false; leave(); } },
    ]);
  };
  const savedDisplayDate = (submitted: CalendarEditorDraft) => {
    let value = submitted.value;
    let day = value.startDate;
    if (submitted.scope === 'series' && submitted.anchorDate && original && original.recurrence !== 'none') {
      const occurrence = local.snapshot.exceptions.find(row => row.eventId === original.id && row.anchorDate === submitted.anchorDate)?.override;
      if (occurrence) { value = occurrence; day = occurrence.startDate; }
      else {
        const next = { ...original, ...value };
        const anchor = rebasedCalendarExceptionDate(original, next, submitted.anchorDate);
        if (isCalendarAnchor(next, anchor)) day = anchor;
      }
    }
    if (displayTimeZone && value.timeZone !== displayTimeZone && !value.allDay) {
      const [instant, ambiguous] = v2WallTimeCandidates({ date: day, hour: Math.floor(value.startMinute / 60), minute: value.startMinute % 60, timeZone: value.timeZone });
      if (instant !== undefined && ambiguous === undefined) return pinnedClockAt(instant, displayTimeZone).date;
    }
    return day;
  };
  const save = (resetExceptions = false) => void work(async () => {
    if (!local.database) throw new Error('予定の保存先を読み込んでください。');
    const d = latest.current;
    const draftCleanup = draftSession.cleanup();
    if (local.saveEvent) { await local.saveEvent(d, resetExceptions, draftCleanup); onSaved(savedDisplayDate(d)); return; }
    if (d.audience === 'group') throw new Error('共有予定の保存先を確認してください。');
    if (d.scope === 'future') await saveCalendarFutureEvent(local.database, d, draftCleanup);
    else await saveCalendarEvent(local.database, { id: d.eventId ?? undefined, draftId: d.draftId, expectedRevision: d.revision, value: d.value,
      scope: d.scope, anchorDate: d.anchorDate ?? undefined, expectedExceptionRevision: d.exceptionRevision, resetExceptions, reminderMinutes: d.reminderMinutes, draftCleanup });
    onSaved(savedDisplayDate(d)); void local.refresh();
  });
  const saveReminderOnly = () => void work(async () => {
    if (!local.database || !initial.eventId || reminderUnavailable) return;
    local.assertDraftAccess?.(latest.current);
    await saveCalendarReminder(local.database, { scope: reminderScope, eventId: initial.eventId, anchorDate: draft.scope === 'one' ? draft.anchorDate : null, minutes: reminderMinutes });
    onSaved(savedDisplayDate(draft));
  });
  const saveReviewed = () => {
    save();
  };
  const applyRebase = (fresh: EventBasis, value: EventDraft) => {
    if (!fresh.series) return;
    setBasis(fresh);
    change(before => ({ ...before, value, revision: fresh.series!.revision, exceptionRevision: fresh.exception?.revision ?? 0 }));
    setInputRevision(version => version + 1);
    setReview(null); setCanReloadEvent(false); setMergeNotice(true);
  };
  const reloadEvent = () => void work(async () => {
    const submitted = latest.current;
    if (!local.database || !submitted.eventId) return;
    const saved = await readLocalCalendarEventSource(local.database, undefined, { eventId: submitted.eventId, anchorDate: submitted.anchorDate ?? undefined });
    const series = saved.events.find(row => row.id === submitted.eventId);
    const exception = saved.exceptions.find(row => row.eventId === submitted.eventId && row.anchorDate === submitted.anchorDate);
    if (!series || series.readOnly || submitted.scope !== 'series' && (exception?.override === null || !exception && !isCalendarAnchor(series, submitted.anchorDate!))) {
      setCanReloadEvent(false);
      throw new Error('編集していた予定を開けません。入力内容は下書きに保存できます。');
    }
    const anchor = submitted.anchorDate ?? series.startDate;
    const base = basis.series && (submitted.scope === 'series' || (basis.exception?.revision ?? 0) === submitted.exceptionRevision)
      ? calendarDraftScopeValue(submitted.scope, basis.series, anchor, basis.exception?.override) : undefined;
    const values = rebaseCalendarEventInput(submitted.value, calendarDraftScopeValue(submitted.scope, series, anchor, exception?.override), base);
    const fresh = { series, exception };
    if (values.overlaps.length) { Keyboard.dismiss(); setReview({ basis: fresh, values }); }
    else applyRebase(fresh, values.keepInput);
  });
  const deleteLabel = draft.scope === 'one' ? 'この回を削除' : repeated ? '繰り返し全体を削除' : '予定を削除';
  const remove = () => Alert.alert(deleteLabel, draft.scope === 'one'
    ? `${formatJapaneseDate(value.startDate, { year: true })}の「${value.title}」を削除しますか？`
    : repeated ? `「${value.title}」の繰り返し全体を削除しますか？` : `「${value.title}」を削除しますか？`, [
    { text: 'キャンセル', style: 'cancel' }, { text: '削除', style: 'destructive', onPress: () => void work(async () => {
      if (!local.database || !initial.eventId) return; const d = latest.current;
      if (local.deleteEvent) { await local.deleteEvent(d); onClose(); return; }
      await deleteCalendarEvent(local.database, { id: initial.eventId, expectedRevision: d.revision,
        anchorDate: d.scope === 'one' ? d.anchorDate ?? undefined : undefined, expectedExceptionRevision: d.exceptionRevision });
      onClose(); void local.refresh();
    }) },
  ]);
  const pull = useMemo(() => createCalendarGesture(), []);
  useLayoutEffect(() => { pull.update({ canStart: gesture => !registeringChore && !lock.current && scrollTop.current <= 0 && gesture.dy > 18 && gesture.dy > Math.abs(gesture.dx) * 1.5,
    release: gesture => { if (gesture.dy > 85) close(); } }); });
  const categoriesFor = (audience: 'personal' | 'group') => local.categoriesFor?.(audience) ?? local.snapshot.categories;
  const uncategorized = UNCATEGORIZED_CALENDAR_CATEGORY;
  const categoryOptions = [uncategorized, ...categoriesFor(draft.audience ?? 'personal').filter(category => category.id !== uncategorized.id)];
  const selectedCategory = categoryOptions.find(row => row.id === value.categoryId);
  const audienceCategory = (categoryId: string, audience: 'personal' | 'group') =>
    categoriesFor(audience).some(category => category.id === categoryId) ? categoryId : uncategorized.id;
  const matches = value.title.trim() ? chores.filter(chore => chore.name.includes(value.title.trim()) || value.title.trim().includes(chore.name)).slice(0, 4) : [];
  const textKey = `${draft.scope}:${initial.eventId ?? 'new'}:${initial.anchorDate ?? ''}:${inputRevision}`;
  const openCustomRecurrence = () => void work(async () => {
    if (!local.database) throw new Error('入力内容の保存先を確認してください。');
    await persistDraft(latest.current);
    const key = calendarDraftKey(latest.current); onClose();
    router.push({ pathname: '/calendar-repeat', params: { draft: key, returnTo: repeatReturnTo } });
  });
  const canAddChore = Boolean(renderChoreRegistration && !initial.eventId && !value.birthday);
  const openChoreRegistration = () => {
    if (lock.current) return;
    appointmentBeforeChore.current = latest.current;
    if (!hasInput(latest.current)) { setRegisteringChore(true); return; }
    void work(async () => {
      if (!local.database) throw new Error('入力内容の保存先を確認してください。');
      await persistDraft(latest.current);
      setRegisteringChore(true);
    });
  };
  const clocks = choreForm?.entry?.clocks;
  const timeError = readOnly || choreForm ? null : calendarInputTimeError(value);
  const reminderField = reminderSettings.error ? <View style={styles.reminderFailure}>
    <Text accessibilityRole="alert" style={styles.error}>通知設定を読み込めませんでした。</Text>
    <SettingsAction title="通知設定を再読み込み" placement="page" disabled={busy} onPress={reminderSettings.retry} />
  </View> : <CalendarReminderField minutes={reminderMinutes} enabled={reminderSettings.settings.enabled} disabled={busy || reminderUnavailable} onChange={reminderMinutes => change(before => ({ ...before, reminderMinutes }))} />;
  if (draft.audience === 'group' && local.draftOwnerScope !== undefined && local.draftOwnerScope !== draft.ownerScope) return null;
  const canSwipeDismiss = !busy && !choreBusy && !needsExitChoice && !(registeringChore && choreHasInput);
  return <CalendarEditorSurface key={modalRevision} embedded={Boolean(choreForm)} visible={!hiddenForChore} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'overFullScreen'} transparent={Platform.OS === 'android'}
    allowSwipeDismissal={canSwipeDismiss} onRequestClose={() => {
      if (lock.current || choreLock.current) return;
      const nativeDismissed = Platform.OS === 'ios' && canSwipeDismiss;
      if (registeringChore) requestCloseChore(nativeDismissed);
      else close(nativeDismissed);
    }}>
    <KeyboardAvoidingView style={styles.overlay} behavior={!choreForm && Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.sheet, Platform.OS === 'android' && styles.androidSheet]} {...pull.panHandlers}>
        {!choreForm ? <View style={styles.grabber} /> : null}
        {registeringChore && renderChoreRegistration ? <CalendarSheetContent render={renderChoreRegistration} form={{ date: value.startDate, initialValue: value, initialInput: choreInput, audience: draft.audience ?? 'personal',
          onAudienceChange: (audience, input) => { if (choreLock.current) return; carriedChoreInput.current = choreHasInput; setChoreInput(input);
            change(before => ({ ...before, audience, groupId: audience === 'group' ? local.shared?.groupId : undefined, ownerScope: audience === 'group' ? local.shared?.notificationScope : undefined, basisRevision: undefined })); },
          onBack: audience => { if (!choreLock.current) { clearChoreEntry(); if (audience) change(before => ({ ...before, audience, groupId: audience === 'group' ? local.shared?.groupId : undefined, ownerScope: audience === 'group' ? local.shared?.notificationScope : undefined, value: { ...before.value, categoryId: audienceCategory(before.value.categoryId, audience) } })); } },
          onCancel: () => { if (choreLock.current) return; clearChoreEntry(); setError(null); setInputRevision(before => before + 1);
            const value = newAppointmentValue(initial.value.startDate, initial.value.timeZone);
            setExitBaseline(value); change(before => ({ ...before, value }));
            if (local.database) void draftSession.clear(local.database).then(() => setStoredDrafts(new Set())).catch(cause => setError(cause instanceof Error ? cause.message : '入力内容を破棄できませんでした。')); },
          onClose: () => requestCloseChore(), onInputChange: updateChoreInput,
          onSaved: (date, notice) => { onChoreBusyChange(false); void work(async () => {
            if (local.database) await draftSession.clear(local.database);
            onSaved(date, notice);
          }); }, onBusyChange: onChoreBusyChange }} /> : <>
        <CalendarSheetHeader title={readOnly ? '予定の詳細' : initial.eventId ? '予定を編集' : value.birthday ? '誕生日を追加' : '予定を追加'} busy={busy || choreForm?.busy}
          saveLabel={readOnly ? '予定の通知を保存' : undefined}
          closeTitle={exitActions ? '戻る' : '閉じる'} closeExpanded={exitActions} onClose={() => { if (exitActions) setExitActions(false); else close(); }} onSave={choreForm ? choreForm.onSave : readOnly ? value.birthday ? undefined : saveReminderOnly : saveReviewed} saveDisabled={Boolean(categoryEdit || timeError || review) || (readOnly && reminderUnavailable) || (choreForm ? choreForm.disabled : !value.title.trim())} />
        {exitActions ? <View style={styles.exitActions} accessibilityLabel="閉じるときの入力の扱い">
          <View style={{ flex: 1 }}><SettingsAction title="入力を破棄" intent="destructive" disabled={busy} onPress={discardAndClose} /></View>
          <View style={{ flex: 1 }}><SettingsAction title="下書き保存" placement="page" disabled={busy} onPress={saveDraftAndClose} /></View>
        </View> : null}
        {exitActions && error ? <Text accessibilityRole="alert" style={[styles.error, { paddingHorizontal: 16, paddingVertical: 8 }]}>{error}</Text> : null}
        <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets keyboardDismissMode="on-drag" scrollEventThrottle={16}
          onScroll={event => { scrollTop.current = event.nativeEvent.contentOffset.y; }} contentContainerStyle={styles.body}>
          {local.shared && !initial.eventId && !value.birthday ? <View style={styles.field}><View style={styles.audienceRow}><Text style={styles.value}>保存先</Text>
            <SettingsSegments tone="quiet" wide value={draft.audience === 'group' ? 'group' : 'personal'} disabled={busy}
              options={[{ id: 'personal', label: '個人' }, { id: 'group', label: 'グループ共通', disabled: !local.shared.enabled }]}
              onValueChange={audience => { if (choreForm) { if (audience !== draft.audience) onChoreAudience?.(audience); return; } change(before => audience === 'group' ? { ...before, audience, groupId: local.shared!.groupId, ownerScope: local.shared!.notificationScope }
                : { ...before, audience, groupId: undefined, ownerScope: undefined, basisRevision: undefined, value: { ...before.value, categoryId: audienceCategory(before.value.categoryId, audience) } }); }} /></View>
          {!local.shared.enabled ? <Text style={styles.caption}>共有予定は、管理者がグループの互換更新を行うと利用できます。</Text> : null}</View> : initial.eventId && local.shared ? <Text style={styles.caption}>{draft.audience === 'group' ? `${local.shared.name} · グループ共通` : '個人 · 本人のみ'}</Text> : null}
          {readOnly ? googleReadOnly ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(googleReadOnly.externalUrl ?? 'https://calendar.google.com/calendar/u/0/r')}><Text style={styles.action}>Googleカレンダーで編集 ↗</Text></Pressable>
            : <Text style={styles.caption}>共有予定は作成者または管理者が変更できます。</Text> : null}
          {error && !exitActions ? <View><Text accessibilityRole="alert" style={styles.error}>{error}</Text>
            {canReloadEvent ? <AppButton title="最新の予定を確認" variant="quiet" compact disabled={busy} onPress={reloadEvent} /> : null}
            {initial.eventId && local.database && storedDrafts.has(calendarDraftKey(initial)) ? <AppButton title="下書きを破棄して閉じる" variant="quiet" compact disabled={busy} onPress={() => void work(async () => {
              await discardCalendarDraftIfUnchanged(local.database!, draftSession.snapshot(initial) ?? initial, local.assertDraftAccess); onClose(); void local.refresh();
            })} /> : null}</View> : null}
          {mergeNotice && !error ? <Text style={styles.caption} accessibilityLiveRegion="polite">最新の予定に入力を反映しました。保存すると確定します。</Text> : null}
          {review ? <View style={styles.optionsGroup}>
            <Text accessibilityRole="header" style={styles.label}>変更が重なっています</Text>
            {review.values.overlaps.map(label => <View key={label} style={styles.optionField}>
              <Text style={styles.label}>{label}</Text>
              <Text style={styles.caption}>最新　{calendarReviewText(label, review.values.useLatest, local.snapshot.categories)}</Text>
              <Text style={styles.caption}>入力　{calendarReviewText(label, review.values.keepInput, local.snapshot.categories)}</Text>
            </View>)}
            <SettingsAction title="重なる箇所は入力を残す" placement="page" onPress={() => applyRebase(review.basis, review.values.keepInput)} />
            <SettingsAction title="重なる箇所は最新を使う" placement="page" onPress={() => applyRebase(review.basis, review.values.useLatest)} />
          </View> : null}
          {readOnly && !value.birthday ? reminderField : null}
          <View pointerEvents={readOnly || review ? 'none' : 'auto'} accessibilityElementsHidden={Boolean(review)} importantForAccessibility={review ? 'no-hide-descendants' : 'auto'} style={[styles.editorSections, choreForm && styles.choreSections]}>
          {repeated && !value.birthday ? <View style={styles.optionsGroup}><Pressable accessibilityRole="button" accessibilityLabel="変更する範囲を選択" accessibilityValue={{ text: CALENDAR_EDIT_SCOPES.find(row => row.value === draft.scope)?.label ?? '' }} disabled={busy || readOnly || !initial.anchorDate} onPress={() => setScopeOpen(true)} style={styles.optionSelect}>
            <Text style={[styles.value, styles.optionLabel, labelWidths.option]}>変更範囲</Text><View style={styles.optionInput}><Text style={[styles.value, styles.optionValue]}>{CALENDAR_EDIT_SCOPES.find(row => row.value === draft.scope)?.label}</Text><Chevron direction="down" /></View>
          </Pressable></View> : null}
          <View style={styles.inputPanel}>
          <View style={styles.inputGroup}>
          {/* Native text stays authoritative while typing; JS still captures every change for saving. */}
          {choreForm && !choreForm.entry?.titleEditable ? <Pressable accessibilityRole="button" accessibilityLabel="追加する家事を選び直す" accessibilityValue={{ text: value.title }} disabled={busy} onPress={onChooseChore} style={styles.choreName}>
            <SymbolView name={{ ios: 'text.alignleft', android: 'title' }} size={18} tintColor={palette.muted} /><Text style={[styles.value, styles.titleInput, styles.nameLabel, { flex: 1 }]}>{value.title}</Text><Chevron />
          </Pressable> : <CalendarTextInput icon={{ ios: 'text.alignleft', android: 'title' }} key={`${textKey}:title`} accessibilityLabel={choreForm ? '家事名' : '予定名'} defaultValue={value.title} placeholder={choreForm ? '家事名' : value.birthday ? '名前・誕生日' : '予定名'} style={[styles.textInput, styles.titleInput]} maxLength={160} editable={!busy && !readOnly && !review} onChangeText={title => change(before => ({ ...before, value: titleDateTime.change(before.value, title, !initial.eventId && !initial.value.title.trim() && !readOnly && !choreForm && !before.value.birthday) }))} />}
          {matches.length && !choreForm && !value.birthday && !initial.eventId ? <View style={styles.existing}><Text style={styles.label}>登録済みの家事</Text>{matches.map(chore => <Pressable key={chore.id} accessibilityRole="button" accessibilityLabel={`${chore.name}の説明を見る`} disabled={busy || readOnly} onPress={() => {
            if (lock.current) return;
            if (onPreviewChore) onPreviewChore(chore.onOpen);
            else { onClose(); chore.onOpen(); }
          }} style={styles.existingRow}>
            <Text style={styles.value}>{chore.name}{chore.minutes ? ` · 約${chore.minutes}分` : ''}</Text><Chevron /></Pressable>)}</View> : null}
          {!value.birthday && !choreForm ? <><View style={styles.inputSeparator} /><CalendarTextInput icon={{ ios: 'mappin', android: 'location_on' }} key={`${textKey}:location`} accessibilityLabel="予定の場所" autoCorrect={false} defaultValue={value.location} style={styles.textInput} maxLength={300} placeholder="場所（任意）" editable={!busy && !readOnly && !review} onChangeText={location => patch({ location })} /></> : null}
          </View>
          {canAddChore || choreForm ? <View style={styles.choreControls}>
            {canAddChore || choreForm?.entry?.titleEditable ? <Pressable accessibilityRole="button" accessibilityLabel={choreForm ? '追加する家事を選び直す' : '家事を追加'} disabled={busy || readOnly} onPress={() => { if (choreForm) onChooseChore?.(); else openChoreRegistration(); }} style={styles.choreSelect}>
              <SymbolView name={{ ios: 'checklist', android: 'checklist' }} size={18} tintColor={palette.accent} /><Text style={[styles.action, styles.nameLabel, { flex: 1 }]}>{choreForm ? '家事を選び直す' : '家事を選ぶ'}</Text><Chevron />
            </Pressable> : null}
            {choreForm && onClearChore ? <ClearChoreButton disabled={busy} onPress={onClearChore} /> : null}
          </View> : null}
          </View>
          {choreForm?.entry?.details ? <View style={styles.optionsGroup}><Pressable accessibilityRole="button" accessibilityLabel="家事の詳細設定" accessibilityState={{ expanded: detailsOpen }} onPress={() => { if (choreForm.entry?.onDetailsToggle) choreForm.entry.onDetailsToggle(); else setDetailsOpen(before => !before); }} style={styles.optionSelect}><Text style={[styles.value, { flex: 1 }]}>詳細設定</Text><Chevron direction={detailsOpen ? 'up' : 'down'} /></Pressable>{detailsOpen ? <View>{choreForm.entry.details}</View> : null}</View> : null}
          <View style={styles.scheduleContent}>
          <View style={styles.scheduleTop}><Text style={styles.scheduleTitle}>{value.birthday ? '誕生日' : '日時'}</Text>{!value.birthday ? <View style={styles.allDayControl}><Text style={styles.value}>終日</Text><SettingsCheckbox accessibilityLabel="終日" value={value.allDay} disabled={busy || readOnly} onValueChange={allDay => { titleDateTime.manual('allDay'); patch({ allDay }); }} /></View> : null}</View>
          <View style={styles.dateRow}>{!value.birthday ? <Text style={[styles.dateLabel, labelWidths.date]}>開始</Text> : null}<CalendarField borderless hideLabel commitOnDone disabled={busy || readOnly} label={value.birthday ? '誕生日' : '開始日'} date={value.startDate} minute={value.startMinute} mode="date" onDate={date => {
            titleDateTime.manual('startDate'); change(before => ({ ...before, value: moveCalendarStart(before.value, { startDate: date }) }));
          }} />{!value.allDay ? <View style={styles.timeField}><CalendarField borderless hideLabel commitOnDone disabled={busy || readOnly} label="開始" date={value.startDate} minute={clocks?.start ?? value.startMinute} empty={Boolean(clocks && clocks.start === null)} mode="time" onMinute={startMinute => { titleDateTime.manual('startMinute'); if (clocks) clocks.onChange('start', startMinute); else change(before => ({ ...before, value: moveCalendarStart(before.value, { startMinute }) })); }} /></View> : null}</View>
          {!value.birthday ? <View style={styles.dateRow}><Text style={[styles.dateLabel, labelWidths.date]}>終了</Text>
            <CalendarField borderless hideLabel commitOnDone disabled={busy || readOnly} label="終了日" date={value.endDate} minute={value.endMinute} mode="date" onDate={endDate => { titleDateTime.manual('endDate'); patch({ endDate }); }} />
            {!value.allDay ? <View style={styles.timeField}><CalendarField borderless hideLabel commitOnDone disabled={busy || readOnly} label="終了" date={value.endDate} minute={clocks?.end ?? value.endMinute} empty={Boolean(clocks && clocks.end === null)} mode="time" onMinute={endMinute => { titleDateTime.manual('endMinute'); if (clocks) clocks.onChange('end', endMinute); else patch({ endMinute }); }} /></View> : null}
          </View> : null}
          {timeError ? <Text accessibilityLiveRegion="polite" style={styles.error}>{timeError}</Text> : null}
          {value.timeZone !== displayTimeZone ? <Text style={[styles.caption, { textAlign: 'right' }]}>地域：{value.timeZone}</Text> : null}
          </View>
          {!choreForm ? <View style={styles.optionsGroup}>
          {!value.birthday && draft.scope !== 'one' ? <View style={styles.optionField}>
            <Pressable accessibilityRole="button" accessibilityLabel="繰り返しを選択" accessibilityValue={{ text: recurrenceLabel(value) }} accessibilityState={{ expanded: repeatOpen }} disabled={busy || readOnly} onPress={() => setRepeatOpen(true)} style={styles.optionSelect}><Text style={[styles.value, styles.optionLabel, labelWidths.option]}>繰り返し</Text><View style={styles.optionInput}><Text numberOfLines={2} style={[styles.value, styles.optionValue]}>{recurrenceLabel(value)}</Text><Chevron direction="down" /></View></Pressable>
            {value.recurrence !== 'none' ? <View style={styles.repeatEnd}><View style={styles.switchRow}><Text style={styles.value}>繰り返しの終了日</Text><SettingsCheckbox disabled={busy || readOnly} accessibilityLabel="繰り返しに終了日を設定" value={value.untilDate !== null} onValueChange={on => { titleDateTime.manual('recurrence'); patch({ untilDate: on ? addDays(value.startDate, 365) : null }); }} /></View>
              {value.untilDate ? <CalendarField disabled={busy || readOnly} label="繰り返しの終了日" date={value.untilDate} minute={0} mode="date" onDate={untilDate => { titleDateTime.manual('recurrence'); patch({ untilDate }); }} /> : null}</View> : null}
          </View> : null}
          <View>
            <Pressable accessibilityRole="button" accessibilityLabel="分類を選択" accessibilityValue={{ text: selectedCategory?.name ?? '未選択' }} accessibilityState={{ expanded: categoryOpen }} disabled={busy || readOnly} onPress={() => setCategoryOpen(v => !v)} style={styles.optionSelect}>
              <Text style={[styles.value, styles.optionLabel, labelWidths.option]}>分類</Text><View style={styles.optionInput}><View style={styles.categoryValue}>{selectedCategory ? <View style={[styles.swatchSmall, { backgroundColor: selectedCategory.color }]} /> : null}<Text style={styles.value}>{selectedCategory?.name ?? '分類を選択'}</Text></View><Chevron direction={categoryOpen ? 'up' : 'down'} /></View>
            </Pressable>
            {categoryOpen ? <View style={styles.categoryMenu}><ScrollView nestedScrollEnabled style={styles.categoryOptions} keyboardShouldPersistTaps="handled">
              {categoryOptions.map(category => <Pressable key={category.id} accessibilityRole="button" accessibilityLabel={category.id === uncategorized.id ? '未分類を選択' : `${category.name}の分類を選択`} accessibilityState={{ selected: category.id === value.categoryId }} disabled={busy || readOnly}
                style={[styles.categoryOption, category.id === value.categoryId && { backgroundColor: palette.accentSoft }]} onPress={() => {
                  const birthday = !initial.eventId && draft.audience !== 'group' && category.id === 'birthday';
                  patch({ categoryId: category.id, ...(!initial.eventId && draft.audience !== 'group' ? { birthday } : {}),
                    ...(birthday ? { allDay: true, recurrence: 'yearly', untilDate: null, endDate: value.startDate, customRecurrence: undefined } : {}) });
                  setCategoryOpen(false);
                }}>
                <View style={[styles.swatchSmall, { backgroundColor: category.color }]} /><Text style={[styles.value, { flex: 1 }]}>{category.name}</Text>{category.id === value.categoryId ? <Text style={styles.action}>✓</Text> : null}</Pressable>)}
            </ScrollView><View style={styles.categoryActions}><SettingsAction title="分類を追加" placement="page" disabled={busy} onPress={() => { setCategoryOpen(false); setCategoryEdit({ revision: 0, name: '', color: CATEGORY_PRESETS[0] }); setCustom(false); }} />
              {selectedCategory && selectedCategory.id !== uncategorized.id ? <SettingsAction title={draft.audience === 'group' ? 'この予定の分類を変更' : '分類を編集'} placement="page" disabled={busy} onPress={() => { setCategoryOpen(false); setCategoryEdit({ ...selectedCategory }); setCustom(false); }} /> : null}</View></View> : null}
          </View>
          {!value.birthday && !readOnly ? <View style={{ borderTopWidth: 1, borderColor: palette.border }}>{reminderField}</View> : null}
          </View> : null}
          {categoryEdit ? <View style={styles.colorPanel}><Text style={styles.heading}>{categoryEdit.id ? '分類の色' : '新しい分類'}</Text>
            <FormTextInput accessibilityLabel="分類名" style={styles.categoryInput} value={categoryEdit.name} placeholder="例：学校" maxLength={40} editable={!busy} onChangeText={name => setCategoryEdit(before => before && ({ ...before, name }))} />
            <View style={styles.wrap}>{CATEGORY_PRESETS.map(color => <Pressable key={color} accessibilityRole="button" accessibilityLabel={`色 ${color}`} accessibilityState={{ selected: categoryEdit.color === color }}
              disabled={busy} style={[styles.swatch, { backgroundColor: color }, categoryEdit.color === color && styles.swatchSelected]} onPress={() => {
                setCategoryEdit(before => before && ({ ...before, color })); setRgb(color.slice(1).match(/../g)!.map(v => String(parseInt(v, 16)))); setCustom(false);
              }} />)}</View>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setCustom(v => !v); setRgb(categoryEdit.color.slice(1).match(/../g)!.map(v => String(parseInt(v, 16)))); }} style={styles.select}><Text style={styles.action}>カスタムカラー</Text><Chevron direction={custom ? 'up' : 'down'} /></Pressable>
            {custom ? <View style={styles.row}>{['R', 'G', 'B'].map((name, i) => <View key={name} style={styles.rgb}><Text style={styles.label}>{name}（0〜255）</Text><FormTextInput accessibilityLabel={`カラー${name}`} style={[styles.categoryInput, { textAlign: 'center' }]} keyboardType="number-pad" value={rgb[i]} maxLength={3} editable={!busy} onChangeText={text => {
              const next = latestRgb.current.map((v, n) => n === i ? text.normalize('NFKC').replace(/[^0-9]/g, '') : v); setRgb(next);
              if (next.every(v => v !== '' && Number(v) <= 255)) setCategoryEdit(before => before && ({ ...before, color: '#' + next.map(v => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase() }));
            }} /></View>)}</View> : null}
            <View style={[styles.colorPreview, { borderColor: categoryColor(categoryEdit.color, scheme === 'dark') }]}><View style={[styles.swatchSmall, { backgroundColor: categoryEdit.color }]} /><Text style={styles.value}>{categoryEdit.name || 'プレビュー'} · {categoryEdit.color}</Text></View>
            <View style={styles.row}><SettingsAction title="閉じる" accessibilityLabel="分類の編集を閉じる" disabled={busy} onPress={() => setCategoryEdit(null)} />
              <SettingsAction title={draft.audience === 'group' ? '予定に適用' : '分類を保存'} disabled={busy || !categoryEdit.name.trim() || custom && !rgb.every(v => v !== '' && Number(v) <= 255)} onPress={() => void work(async () => {
                if (!local.database) throw new Error('保存先を確認してください。');
                if (custom && !latestRgb.current.every(v => v !== '' && Number(v) <= 255)) throw new Error('RGBを0〜255で入力してください。');
                const category = latestCategory.current; if (!category) throw new Error('保存する分類を選び直してください。');
                const body = { id: category.id, expectedRevision: category.revision, name: category.name, color: category.color };
                const id = await (local.saveCategory ? local.saveCategory(body, draft.audience) : saveCalendarCategory(local.database, body));
                await local.refresh(); patch({ categoryId: id }); setCategoryEdit(null);
              })} /></View>
          </View> : null}
          {choreForm ? choreForm.content : <View style={[styles.inputGroup, styles.notesGroup]}><CalendarTextInput icon={{ ios: 'note.text', android: 'notes' }} key={`${textKey}:notes`} accessibilityLabel="予定のメモ" multiline defaultValue={value.notes} style={[styles.textInput, styles.notesInput]} maxLength={4000} placeholder="メモ（任意）" editable={!busy && !readOnly && !review} onChangeText={notes => patch({ notes })} /></View>}
          {!readOnly && initial.eventId && !value.birthday && onDuplicate ? <SettingsAction title="予定を複製" placement="page" disabled={busy} onPress={() => {
            if (lock.current) return;
            const current = latest.current;
            const category = (local.categoriesFor?.(current.audience ?? 'personal') ?? local.snapshot.categories).find(row => row.id === current.value.categoryId);
            onDuplicate(duplicateCalendarDraft({ ...current, editorCategory: category ?? current.editorCategory }));
          }} /> : null}
          {!readOnly && initial.eventId && draft.scope !== 'future' ? <AppButton title={deleteLabel} variant="danger" disabled={busy} onPress={remove} /> : null}
          </View>
        </ScrollView>
        </>}
      </View>
    </KeyboardAvoidingView>
    {scopeOpen && original && initial.anchorDate ? <CalendarRecurrenceScopePicker value={draft.scope} futureDisabled={!isCalendarAnchor(original, initial.anchorDate)} onClose={() => setScopeOpen(false)} onSelect={(scope: CalendarEditScope) => {
      setScopeOpen(false);
      const exception = basis.exception ?? local.snapshot.exceptions.find(row => row.eventId === original.id && row.anchorDate === initial.anchorDate);
      try {
        change(before => changeCalendarDraftScope(before, scope, original, exception?.override, editedScopeFields.current));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '変更する範囲を選び直してください。');
      }
    }} /> : null}
    {repeatOpen ? <CalendarOptionPicker title="繰り返し" value={value.recurrence} options={(Object.keys(RECURRENCE_LABELS) as CalendarRecurrence[]).map(recurrence => ({ value: recurrence, label: RECURRENCE_LABELS[recurrence] }))}
      onClose={() => setRepeatOpen(false)} onCustom={openCustomRecurrence} onSelect={recurrence => { if (recurrence !== 'custom' && Object.hasOwn(RECURRENCE_LABELS, recurrence)) { titleDateTime.manual('recurrence'); patch({ recurrence: recurrence as CalendarRecurrence, customRecurrence: undefined,
        ...(recurrence === 'none' ? { untilDate: null } : {}) }); } }} /> : null}
  </CalendarEditorSurface>;
}
function calendarInputTimeError(value: EventDraft) {
  try {
    validateEventDraft({ ...value, title: '予定', location: '', notes: '' });
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : '日時を確認してください。';
  }
}

function calendarReviewText(label: ReturnType<typeof rebaseCalendarEventInput>['overlaps'][number], value: EventDraft, categories: LocalCalendarBinding['snapshot']['categories']) {
  switch (label) {
    case '予定名': return value.title || '未入力';
    case '場所': return value.location || '未入力';
    case 'メモ': return value.notes || '未入力';
    case '分類': return categories.find(category => category.id === value.categoryId)?.name ?? '未分類';
    case '繰り返し': return recurrenceLabel(value) + (value.untilDate ? ` · ${formatJapaneseDate(value.untilDate, { year: true })}まで` : '');
    case '日時': {
      const start = formatJapaneseDate(value.startDate, { year: true });
      const end = value.startDate === value.endDate ? '' : formatJapaneseDate(value.endDate, { year: true });
      return value.allDay ? `${start}${end ? `〜${end}` : ''} · 終日`
        : `${start} ${minuteLabel(value.startMinute)} 〜 ${end ? `${end} ` : ''}${minuteLabel(value.endMinute)}（${value.timeZone}）`;
    }
  }
}

function CalendarEditorSurface({ embedded, children, ...props }: React.ComponentProps<typeof Modal> & { embedded: boolean }) {
  return embedded ? children : <Modal {...props}>{children}</Modal>;
}
function ClearChoreButton({ disabled, onPress }: { disabled: boolean; onPress(): void }) {
  return <SettingsAction intent="auxiliary" title="選択を解除" accessibilityLabel="家事の選択を解除" disabled={disabled} onPress={onPress} />;
}
function CalendarTextInput({ icon, style, ...props }: TextInputProps & { icon: SymbolViewProps['name'] }) {
  const styles = usePlannerBorderStyles(baseStyles);
  const colors = plannerColorsForScheme(useColorScheme());
  const [mirror, setMirror] = useState(String(props.value ?? props.defaultValue ?? ''));
  const [notesLayout, setNotesLayout] = useState({ height: 48, rowHeight: 48, padding: Math.max(10, (48 - typography.body.fontSize * 1.2) / 2) });
  return <View style={[styles.inputShell, props.multiline && { alignItems: 'flex-start' }]}>
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.inputIcon, props.multiline && { height: notesLayout.rowHeight }]}><SymbolView name={icon} size={18} tintColor={colors.muted} /></View>
    {props.multiline ? <Text pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.notesMeasure}
      onTextLayout={event => { const first = event.nativeEvent.lines[0]; const last = event.nativeEvent.lines.at(-1); if (!first || !last) return;
        const rowHeight = Math.max(48, Math.ceil(first.height) + 20); const padding = (rowHeight - first.height) / 2;
        const height = Math.max(rowHeight, Math.min(180, Math.ceil(last.y + last.height + padding * 2)));
        setNotesLayout(before => before.height === height && before.rowHeight === rowHeight && before.padding === padding ? before : { height, rowHeight, padding }); }}>{mirror + '\u200B'}</Text> : null}
    <FormTextInput {...props} placeholderTextColor={props.placeholderTextColor ?? colors.muted} selectionColor={colors.accent} onChangeText={props.multiline ? text => { setMirror(text); props.onChangeText?.(text); } : props.onChangeText}
      style={[style, styles.inputContents, props.multiline && { height: notesLayout.height, paddingVertical: notesLayout.padding }]} />
  </View>;
}
const baseStyles = StyleSheet.create({
  reminderFailure: { gap: 8, paddingVertical: 8 },
  inputShell: { flexDirection: 'row', alignItems: 'center', backgroundColor: palette.surface },
  inputIcon: { paddingLeft: 12, height: 48, justifyContent: 'center' }, inputContents: { flex: 1, minWidth: 0, borderWidth: 0, backgroundColor: 'transparent' },
  notesMeasure: { position: 'absolute', left: 42, right: 12, top: 10, fontSize: typography.body.fontSize, includeFontPadding: false, opacity: 0 },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: palette.overlay }, sheet: { flex: 1, backgroundColor: palette.background }, androidSheet: { flex: 0, height: '92%', borderTopLeftRadius: 22, borderTopRightRadius: 22, overflow: 'hidden' },
  grabber: { width: 34, height: 4, borderRadius: 2, backgroundColor: palette.inputBorder, alignSelf: 'center', marginTop: 8, marginBottom: 3 },
  exitActions: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: palette.border },
  heading: { ...typography.body, color: palette.ink, fontWeight: '700', flex: 1, textAlign: 'center' },
  body: { padding: 16, paddingBottom: 32, gap: 20 }, editorSections: { gap: 24 }, choreSections: { gap: 16 }, field: { gap: 6 }, row: { flexDirection: 'row', alignItems: 'center', gap: 10 }, wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  audienceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  inputPanel: { padding: 12, gap: 8, backgroundColor: palette.elevated, borderRadius: 12 },
  choreControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }, choreSelect: { flex: 1, minHeight: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  choreName: { minHeight: 48, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  // Match editable text's native font metrics, rather than paragraph leading.
  nameLabel: { lineHeight: undefined, includeFontPadding: false },
  inputGroup: { borderRadius: 10, overflow: 'hidden', backgroundColor: palette.surface }, inputSeparator: { height: 1, backgroundColor: palette.border, marginLeft: 42, marginRight: 12 }, textInput: { paddingHorizontal: 12 }, titleInput: { fontWeight: '500' }, notesInput: { minHeight: 48, maxHeight: 180 },
  notesGroup: { borderWidth: 1, borderColor: palette.border },
  scheduleContent: { padding: 12, gap: 10, backgroundColor: palette.elevated, borderRadius: 12 }, scheduleTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36 }, scheduleTitle: { ...typography.label, color: palette.ink, fontWeight: '600' },
  allDayControl: { flexDirection: 'row', alignItems: 'center', gap: 3 }, dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, dateLabel: { ...typography.label, color: palette.ink, width: 36 }, timeField: { width: 92 },
  action: { ...typography.body, color: palette.accent }, label: { ...typography.caption, color: palette.muted }, value: { ...typography.body, color: palette.ink, flexShrink: 1 },
  caption: { ...typography.caption, color: palette.muted }, error: { ...typography.body, color: palette.warning }, switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 12, paddingHorizontal: 12, minHeight: 46 },
  optionsGroup: { backgroundColor: palette.elevated, paddingHorizontal: 12, borderRadius: 12 }, optionSelect: { minHeight: 60, paddingHorizontal: 0, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 }, optionField: { borderBottomWidth: 1, borderBottomColor: palette.border }, optionLabel: { width: 76, flexShrink: 0 }, optionInput: { flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: palette.surface, borderRadius: 10 }, optionValue: { flex: 1 }, repeatEnd: { paddingHorizontal: 0, paddingBottom: 10, gap: 6 },
  categoryValue: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }, categoryMenu: { borderTopWidth: 1, borderColor: palette.border, overflow: 'hidden' }, categoryOptions: { maxHeight: 220 }, categoryOption: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border }, categoryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  swatchSmall: { width: 14, height: 14, borderRadius: 7, borderWidth: 1, borderColor: palette.inputBorder }, swatch: { width: 38, height: 38, borderRadius: 19, borderWidth: 2, borderColor: palette.border }, swatchSelected: { borderColor: palette.ink, borderWidth: 4 },
  categoryInput: { ...typography.body, color: palette.ink, backgroundColor: palette.surface, borderWidth: 0, borderRadius: 10, paddingHorizontal: 12, minHeight: 48, minWidth: 0 },
  colorPanel: { padding: 12, gap: 12, backgroundColor: palette.elevated, borderRadius: 14 }, rgb: { flex: 1, gap: 4 }, colorPreview: { minHeight: 42, borderWidth: 2, borderRadius: 10, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  existing: { padding: 12, gap: 8, borderTopWidth: 1, borderColor: palette.border, backgroundColor: palette.elevated }, existingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
});
