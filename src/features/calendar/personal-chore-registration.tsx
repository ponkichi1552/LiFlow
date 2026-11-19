import { customChoreReady } from '../chores/custom-chore-readiness';
import { useRef, useState } from 'react';
import { Text, View, useColorScheme } from 'react-native';
import { usePersonalSettingsData } from '@/hooks/use-personal-settings-data';
import type { ChoreDefinition } from '../../domain/chores/types';
import { hasChoreScheduleSettings } from '../../domain/chores/cycle-policy';
import { customChoreInput } from '../../domain/chores/custom-chore';
import { SettingsCheckbox } from '../../components/settings-checkbox';
import { typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { CalendarChorePicker } from '../sharing/v2-ui/calendar-chore-picker';
import { V2ChoreCadence } from '../sharing/v2-ui/chore-cadence';
import { initialCustomChoreOptions, CustomChoreOptionsFields, CustomChoreStepsField, parsedCustomChoreOptions } from '../chores/custom-chore-options';
import { readPersonalCalendarChore, registerPersonalCalendarChore } from '../../platform/storage/repository';
import { newCalendarSubmissionId } from '../../platform/storage/calendar-events';
import type { LocalCalendarBinding } from './use-local-calendar';
import { newEventDraft } from './events';
import { CalendarEditor, type CalendarChoreRegistrationProps } from './calendar-editor';
import { choreCalendarTiming } from '../../domain/chores/calendar-timing';
import { addDays, daysBetween } from '../../domain/scheduling/local-date';
import { changeChoreClock, emptyChoreClocks, withChoreClocks } from './chore-clock-input';
import { registrationChore, registrationOptions, type CalendarChoreInput } from './chore-registration-input';

/** Private registration uses the same calendar form and never a shared writer. */
export function PersonalCalendarChoreRegistration({ local, ...sheet }: CalendarChoreRegistrationProps & { local: LocalCalendarBinding }) {
  const data = usePersonalSettingsData(); const colors = plannerColorsForScheme(useColorScheme());
  const [selection, setSelection] = useState<ChoreDefinition | null | undefined>(() => registrationChore(sheet.initialInput, 'personal', data.snapshot?.chores ?? []));
  const selections = useRef({ ...sheet.initialInput?.selections });
  const [pickerOpen, setPickerOpen] = useState(!sheet.initialInput); const [expanded, setExpanded] = useState(sheet.initialInput?.detailsExpanded ?? false);
  const [draft, setDraft] = useState(() => ({ name: selection?.name ?? sheet.initialInput?.value.title ?? '', date: sheet.initialInput?.value.startDate ?? sheet.date,
    endDate: sheet.initialInput?.value.endDate ?? sheet.initialValue?.endDate ?? sheet.date, allDay: sheet.initialInput?.value.allDay ?? sheet.initialValue?.allDay ?? false,
    startMinute: sheet.initialInput?.clocks.start ?? 540, endMinute: sheet.initialInput?.clocks.end ?? 600, clocks: sheet.initialInput?.clocks ?? emptyChoreClocks(),
    repeat: sheet.initialInput?.repeat ?? false, interval: sheet.initialInput?.interval ?? '7', monthly: sheet.initialInput?.monthly ?? false, ...initialCustomChoreOptions, ...sheet.initialInput?.options }));
  const [initialDraft] = useState(draft);
  const input = useRef(draft); const pending = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [initialOperation] = useState(newCalendarSubmissionId); const selected = useRef(selection); const operation = useRef(initialOperation);
  const [initialReading] = useState(() => { const reading = selection ? readPersonalCalendarChore(data.database, selection.id) : null; void reading?.catch(() => {}); return reading; });
  const frozen = useRef<Promise<Awaited<ReturnType<typeof readPersonalCalendarChore>>> | null>(initialReading);
  const edit = (patch: Partial<typeof draft>) => { if (pending.current) return; input.current = { ...input.current, ...patch }; setDraft(input.current); setError(null); };
  const choose = (chore: ChoreDefinition | null) => {
    if (pending.current) return;
    operation.current = newCalendarSubmissionId(); selected.current = chore; setSelection(chore); setPickerOpen(false); setExpanded(false);
    selections.current = { personal: chore?.id ?? null };
    const reading = chore ? readPersonalCalendarChore(data.database, chore.id) : null; frozen.current = reading; void reading?.catch(() => {});
    edit({ name: chore?.name ?? '', repeat: false, interval: String(chore?.recommendedCycleDays ?? chore?.frequencyDaysByMode.balanced ?? 7), monthly: false,
      ...initialCustomChoreOptions, ...(chore ? { radius: String(chore.userWindowRadiusDays ?? chore.windowRadiusDays), minutes: String(chore.estimatedMinutes ?? 15), load: chore.load, holidayPriority: chore.holidayPriority } : {}) });
  };
  const save = async () => {
    if (pending.current) return; pending.current = true; setBusy(true); sheet.onBusyChange(true); setError(null);
    try {
      if (data.database !== local.database) throw new Error('個人家事の保存先が変わっています。開き直してください。');
      const value = input.current; const existing = selected.current; const observed = frozen.current ? await frozen.current : undefined;
      const options = parsedCustomChoreOptions({ ...value, radius: '0' });
      const timing = choreCalendarTiming(withChoreClocks({ ...newEventDraft(value.date, data.snapshot?.timeZone ?? 'Asia/Tokyo'), ...value, startDate: value.date }, value.clocks));
      const period = value.repeat ? customChoreInput(value.name, value.monthly ? 30 : value.interval).intervalDays : undefined;
      await registerPersonalCalendarChore(data.database, { operationId: operation.current, ...(existing && observed ? {
        choreId: existing.id, expectedDefinition: observed.signature, expectedRoundId: observed.roundId, expectedPlanRevision: observed.planRevision,
      } : {}), name: value.name, date: value.date, repeat: value.repeat, timing, ...(period ? { intervalDays: period, monthly: value.monthly } : {}), options });
      void data.refresh().catch(() => {}); sheet.onSaved(value.date);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '家事を保存できませんでした。'); }
    finally { pending.current = false; setBusy(false); sheet.onBusyChange(false); }
  };
  if (pickerOpen) return <CalendarChorePicker chores={(data.snapshot?.chores ?? []).filter(chore => hasChoreScheduleSettings(chore) && chore.personalSchedulingKind !== 'seasonal')}
    onSelect={chore => choose(chore as ChoreDefinition)} onNew={() => choose(null)} onClose={() => selection === undefined ? sheet.onBack() : setPickerOpen(false)} />;
  const readInput = (): CalendarChoreInput => {
    const value = input.current;
    return { ...sheet.initialInput, value: { ...newEventDraft(value.date, data.snapshot?.timeZone ?? 'Asia/Tokyo'), title: value.name, allDay: value.allDay, endDate: value.endDate, startMinute: value.startMinute, endMinute: value.endMinute },
      clocks: { ...value.clocks }, repeat: value.repeat, interval: value.interval, monthly: value.monthly, options: registrationOptions(value), detailsExpanded: expanded,
      selections: { ...selections.current, personal: selected.current?.id ?? null }, recipeId: selected.current?.personalRecipeId };
  };
  const entry = { id: selection?.id ?? 'new', titleEditable: !selection,
    value: { ...newEventDraft(draft.date, data.snapshot?.timeZone ?? 'Asia/Tokyo'), title: draft.name, allDay: draft.allDay, endDate: draft.endDate, startMinute: draft.startMinute, endMinute: draft.endMinute },
    onChange: (value: ReturnType<typeof newEventDraft>) => edit({ name: value.title, date: value.startDate, endDate: value.endDate, allDay: value.allDay, startMinute: value.startMinute, endMinute: value.endMinute }), detailsExpanded: expanded,
    onDetailsToggle: () => setExpanded(before => !before),
    clocks: { ...draft.clocks, onChange: (field: 'start' | 'end', minute: number) => {
      const current = input.current;
      const next = changeChoreClock({ ...newEventDraft(current.date, data.snapshot?.timeZone ?? 'Asia/Tokyo'), ...current, startDate: current.date }, current.clocks, field, minute);
      edit({ clocks: next.clocks, startMinute: next.value.startMinute, endMinute: next.value.endMinute, endDate: next.value.endDate });
    } },
    details: <View style={{ gap: 10 }}>
      <View style={{ minHeight: 52, borderBottomWidth: draft.repeat ? 1 : 0, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={[typography.body, { color: colors.ink }]}>繰り返す</Text>
        <SettingsCheckbox accessibilityLabel="追加する家事を繰り返す" value={draft.repeat} disabled={busy} onValueChange={repeat => edit({ repeat })} /></View>
      {draft.repeat ? <V2ChoreCadence today={data.snapshot?.today ?? sheet.date} anchor={draft.date} interval={draft.interval} monthly={draft.monthly} accessibilityLabel="追加する家事の周期" disabled={busy}
        onInterval={interval => edit({ interval })} onMonthly={monthly => edit({ monthly })} onAnchor={date => edit({ date, endDate: addDays(date, daysBetween(input.current.date, input.current.endDate)) })} /> : null}
      {draft.repeat ? <CustomChoreOptionsFields value={draft} onChange={edit} disabled={busy} showWindow={false} showEstimatedMinutes={!selection || selection.customPersonal === true} /> : null}
      {draft.repeat && !selection ? <CustomChoreStepsField value={draft.steps} disabled={busy} onChange={steps => edit({ steps })} /> : null}
    </View> };
  return <CalendarEditor key={selection?.id ?? 'new'} local={local} initial={{ eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', audience: 'personal', value: entry.value }}
    choreForm={{ entry, busy, hasInput: Boolean(selection) || JSON.stringify(draft) !== JSON.stringify(initialDraft),
      disabled: busy || !customChoreReady(draft.name, draft.repeat && !draft.monthly ? draft.interval : 1), onSave: () => void save(), content: error ? <Text accessibilityRole="alert" style={[typography.caption, { color: colors.warning }]}>{error}</Text> : null }}
    displayTimeZone={data.snapshot?.timeZone ?? 'Asia/Tokyo'} onChooseChore={() => setPickerOpen(true)} onClearChore={() => sheet.onCancel ? sheet.onCancel() : sheet.onBack()}
    onChoreInputChange={sheet.onInputChange}
    onChoreAudience={audience => { if (!pending.current) { if (sheet.onAudienceChange) sheet.onAudienceChange(audience, readInput()); else sheet.onBack(audience); } }} onClose={sheet.onClose} onSaved={sheet.onSaved} />;
}
