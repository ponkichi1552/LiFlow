import { useState } from 'react';
import { Text, View, useColorScheme } from 'react-native';
import { typography } from '../../../components/planner-ui';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { daysBetween } from '../../../domain/scheduling/local-date';
import type { LocalDate } from '../../../domain/shared/types';
import { CalendarEditor, type CalendarChoreRegistrationProps } from '../../calendar/calendar-editor';
import type { CalendarSheetForm } from '../../calendar/calendar-sheet-header';
import type { LocalCalendarBinding } from '../../calendar/use-local-calendar';
import { EMPTY_LOCAL_CALENDAR } from '../../../platform/storage/calendar-events';
import { newEventDraft, type EventDraft } from '../../calendar/events';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { V2AddChore } from './add-chore';
import { V2DateForm, type V2DateFormProps } from './date-form';
import { changeChoreClock, emptyChoreClocks, type ChoreClocks } from '../../calendar/chore-clock-input';
import { registrationChore, type CalendarChoreInput } from '../../calendar/chore-registration-input';
import { sharedRecipeId } from '../v2/standard-catalog';
import { initialCustomChoreOptions } from '../../chores/custom-chore-options';

type SelectedChore = { choreId: string; roundId: string; subjectId: string; date: LocalDate; value: EventDraft; clocks: ChoreClocks; input?: CalendarChoreInput };

/** The picker replaces only sheet contents; selecting a chore never pushes a route. */
export function V2CalendarChoreRegistration({ model, actions, busy, run, readOwnCalendar, local, ...sheet }: CalendarChoreRegistrationProps & {
  model: V2GroupScreenModel; actions: V2GroupController['actions']; busy: boolean;
  run(work: () => Promise<unknown>): Promise<void>; readOwnCalendar?: V2DateFormProps['readOwnCalendar'];
  local?: LocalCalendarBinding;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  const savedRegistration = (fallback: LocalDate) => (_id: string, date?: LocalDate, needsDateApproval?: boolean) => {
    sheet.onSaved(date ?? fallback, needsDateApproval ? '日時は担当者の承認後に確定します。' : undefined);
  };
  const restored = registrationChore(sheet.initialInput, 'group', model.plan.chores, model.plan.groupId);
  function scheduled(choreId: string, date: LocalDate, input?: CalendarChoreInput): SelectedChore | null {
    const candidates = [...model.plan.occurrences, ...(model.calendarLong ?? [])].filter(round => round.choreId === choreId && round.activeInPeriod)
      .flatMap(round => round.subjects.filter(subject => subject.required && (subject.subjectUserId === null || subject.subjectUserId === model.viewerUserId))
        .map(subject => ({ round, subject, distance: Math.abs(daysBetween(subject.suggestedDate, date)) })))
      .sort((a, b) => a.distance - b.distance || a.round.anchorDate.localeCompare(b.round.anchorDate));
    const next = candidates[0]; if (!next) return null;
    const value = { ...(input?.value ?? sheet.initialValue ?? newEventDraft(date, model.plan.timeZone)), title: model.plan.chores.find(chore => chore.id === choreId)?.name ?? '' };
    return { choreId, roundId: next.round.id, subjectId: next.subject.id, date, value, clocks: input?.clocks ?? emptyChoreClocks(), input: input && { ...input, value } };
  }
  const [selected, setSelected] = useState<SelectedChore | null>(() => {
    const cfg = model.configurations.find(row => row.choreId === restored?.id)?.configuration;
    return restored?.enabled && cfg?.active !== false && cfg && sheet.initialInput && (!cfg.once || cfg.anchorDate === sheet.initialInput.value.startDate) ? scheduled(restored.id, sheet.initialInput.value.startDate, sheet.initialInput) : null;
  });
  const [repeating, setRepeating] = useState(sheet.initialInput?.repeat ?? false);
  const [detailsExpanded, setDetailsExpanded] = useState(sheet.initialInput?.detailsExpanded ?? false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  // Some coordinators report errors on the underlying page. Keep this sheet's
  // save result explicit too, including a coordinator that refuses busy work.
  const commit = async (work: () => Promise<unknown>) => {
    let ran = false; let failure: unknown;
    await run(async () => { ran = true; try { return await work(); } catch (cause) { failure = cause; throw cause; } });
    if (failure) throw failure;
    if (!ran) throw new Error('保存中の操作が終わってから、もう一度お試しください。');
  };
  const renderForm = (form: CalendarSheetForm) => {
    const name = selected ? model.plan.chores.find(chore => chore.id === selected.choreId)?.name ?? '選択した家事' : form.entry?.value.title ?? '';
    const entry = form.entry ? { ...form.entry, detailsExpanded, onDetailsToggle: () => setDetailsExpanded(before => !before), value: { ...form.entry.value, title: name }, onChange: (value: typeof form.entry.value) => {
      form.entry!.onChange(value); if (selected) setSelected(before => before && ({ ...before, date: value.startDate, value }));
    }, ...(form.entry.clocks ? { clocks: { ...form.entry.clocks, onChange: (field: 'start' | 'end', minute: number) => {
      form.entry!.clocks!.onChange(field, minute);
      if (selected) { const next = changeChoreClock(form.entry!.value, form.entry!.clocks!, field, minute);
        setSelected(before => before && ({ ...before, date: next.value.startDate, value: next.value, clocks: next.clocks })); }
    } } } : {}) } : {
      value: { ...newEventDraft(sheet.date, model.plan.timeZone), title: name, allDay: true }, onChange() {},
    };
    const binding = local ?? { snapshot: EMPTY_LOCAL_CALENDAR, loading: false, error: null, refresh: async () => {}, shared: { groupId: model.plan.groupId, name: '共有グループ', enabled: true } };
    return <CalendarEditor key={selected?.choreId ?? form.entry?.id ?? 'new'} initial={{ eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', audience: 'group', groupId: model.plan.groupId, ownerScope: local?.shared?.notificationScope, value: entry.value }}
      local={binding} choreForm={{ ...form, entry, hasInput: Boolean(selected) || form.hasInput }} displayTimeZone={model.plan.timeZone}
      onChoreInputChange={sheet.onInputChange} onClose={sheet.onClose} onSaved={sheet.onSaved}
      onChooseChore={selected ? () => { setSelected(null); setRepeating(false); } : form.entry?.onChoose} onClearChore={() => sheet.onCancel ? sheet.onCancel() : sheet.onBack()} onChoreAudience={audience => {
        const input = form.entry?.readInput?.() ?? selected?.input ?? sheet.initialInput ?? { value: entry.value, clocks: emptyChoreClocks(), repeat: repeating, interval: '7', monthly: false, options: initialCustomChoreOptions,
          selections: { group: selected?.choreId ?? null }, recipeId: selected ? sharedRecipeId(model.plan.groupId, selected.choreId) : undefined };
        if (sheet.onAudienceChange) sheet.onAudienceChange(audience, { ...input, detailsExpanded }); else sheet.onBack(audience);
      }} />;
  };
  if (selected) {
    const round = [...model.plan.occurrences, ...(model.calendarLong ?? [])].find(row => row.id === selected.roundId);
    const subject = round?.subjects.find(row => row.id === selected.subjectId);
    if (!round || !subject || subject.completed) return renderForm({ disabled: true, busy, content: <Text accessibilityRole="alert" style={{ ...typography.body, color: colors.muted }}>
      {subject?.completed ? 'この回は完了済みです。' : 'この家事の予定が更新されました。家事を選び直してください。'}</Text> });
    const chore = model.plan.chores.find(row => row.id === selected.choreId);
    if (repeating && chore) return <V2AddChore model={model} actions={actions} busy={busy} run={commit} calendarDate={selected.date} calendarValue={selected.value} calendarClocks={selected.clocks} calendarInput={selected.input} initialChore={chore}
      onBack={() => setRepeating(false)} onRepeatChange={(repeat, value, clocks, input) => { if (value) setSelected(before => before && ({ ...before, date: value.startDate, value, clocks: clocks ?? before.clocks, input: input && { ...input, repeat } })); setRepeating(repeat); }} onBusyChange={sheet.onBusyChange} renderCalendarForm={renderForm}
      onCreated={savedRegistration(selected.date)} />;
    return <V2DateForm model={model} round={round} subject={subject} actions={actions} busy={busy} run={commit} readOwnCalendar={readOwnCalendar}
      initialDate={selected.date} calendarValue={selected.value} calendarClocks={selected.clocks} calendarInput={selected.input} onSaved={date => sheet.onSaved(date ?? selected.date)} onRepeatChange={(repeat, value, clocks, input) => {
        if (value) setSelected(before => before && ({ ...before, date: value.startDate, value, clocks: clocks ?? before.clocks, input: input && { ...input, repeat } })); setRepeating(repeat);
      }} onBusyChange={sheet.onBusyChange} renderCalendarForm={renderForm} />;
  }
  return <View style={{ flex: 1 }}>
    {selectionError ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning, paddingHorizontal: 16 }}>{selectionError}</Text> : null}
    <V2AddChore model={model} actions={actions} busy={busy} run={commit} calendarDate={sheet.date} calendarValue={sheet.initialValue} calendarInput={sheet.initialInput} initialChore={restored ?? undefined} onBack={sheet.onBack} onBusyChange={sheet.onBusyChange}
      renderCalendarForm={renderForm} onCreated={savedRegistration(sheet.date)} onOpenScheduled={(choreId, date, input) => {
        const next = scheduled(choreId, date, input);
        if (!next) { setSelectionError('この家事の予定を取得できませんでした。家事を選び直してください。'); return false; }
        setSelectionError(null); setSelected(next); return true;
      }} />
  </View>;
}
