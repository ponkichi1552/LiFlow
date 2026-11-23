import { customChoreReady } from '../../chores/custom-chore-readiness';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, Text, View, useColorScheme } from 'react-native';
import { AppButton, SectionHeading } from '../../../components/planner-ui';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { SettingsAction, SettingsPanel } from '../../../components/settings-controls';
import { SettingsCheckbox } from '../../../components/settings-checkbox';
import { Chevron } from '../../../components/chevron';
import { CustomChoreFields, ChoreAddHeader } from '../../chores/custom-chore-fields';
import { customChoreInput } from '../../../domain/chores/custom-chore';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { chorePolicyFromPreset, type SharedChoreRotation } from '../v2/model';
import { V2FormScrollView, V2TextField, v2FormStyles as styles } from './form-controls';
import { v2ChoreDetailCodecs } from './chore-detail-fields';
import { V2ResponsibilityChoices, type V2ResponsibilityPreset } from './responsibility-choices';
import { V2RotationSettings } from './rotation-settings';
import { V2ConfigurationDates } from './configuration-dates';
import { V2ChoreCadence } from './chore-cadence';
import { initialCustomChoreOptions, CustomChoreOptionsFields, CustomChoreStepsField, parsedCustomChoreOptions } from '../../chores/custom-chore-options';
import type { LocalDate } from '../../../domain/shared/types';
import { CalendarField } from '../../calendar/calendar-field';
import { CalendarChorePicker, type CalendarChoreChoice } from './calendar-chore-picker';
import { supportsOneOffChores } from '../v2/payload-schema';
import { CalendarSheetContent, type CalendarSheetForm } from '../../calendar/calendar-sheet-header';
import { newEventDraft } from '../../calendar/events';
import { NumberInputField } from '../../../components/number-input-field';
import { choreCalendarTiming } from '../../../domain/chores/calendar-timing';
import { addDays, daysBetween } from '../../../domain/scheduling/local-date';
import type { EventDraft } from '../../calendar/events';
import { changeChoreClock, emptyChoreClocks, withChoreClocks, type ChoreClocks } from '../../calendar/chore-clock-input';
import { registrationOptions, type CalendarChoreInput } from '../../calendar/chore-registration-input';
import { sharedRecipeId } from '../v2/standard-catalog';
import { useChoreDraftExit } from '../../chores/use-chore-draft-exit';

type SavedChore = { id: string; needsDateApproval: boolean };

export function V2AddChore({ model, actions, busy, run, onCreated, onBack, header, calendarDate, onOpenScheduled, renderCalendarForm, onBusyChange, initialChore, onRepeatChange, calendarValue, calendarClocks, calendarInput }: { model?: V2GroupScreenModel; actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>; onCreated: (id: string, date?: LocalDate, needsDateApproval?: boolean) => void; onBack: () => void; header?: ReactNode;
  calendarDate?: LocalDate; onOpenScheduled?(choreId: string, date: LocalDate, input?: CalendarChoreInput): boolean | void;
  renderCalendarForm?(form: CalendarSheetForm): ReactNode; onBusyChange?(busy: boolean): void;
  initialChore?: CalendarChoreChoice; onRepeatChange?(repeat: boolean, value?: EventDraft, clocks?: ChoreClocks, input?: CalendarChoreInput): void; calendarValue?: EventDraft; calendarClocks?: ChoreClocks; calendarInput?: CalendarChoreInput }) {
  const colors = plannerColorsForScheme(useColorScheme());
  const administrator = Boolean(model && model.viewerUserId === model.adminUserId);
  const members = model?.plan.members.filter(member => member.active) ?? [];
  const singleSupported = Boolean(model && supportsOneOffChores(model.plan.algorithm));
  const incomingValue = calendarInput?.value ?? calendarValue; const incomingClocks = calendarInput?.clocks ?? calendarClocks;
  const selections = useRef({ ...calendarInput?.selections });
  const [draft, setDraft] = useState(() => {
    const configuration = model?.configurations.find(row => row.choreId === initialChore?.id)?.configuration;
    const policy = configuration?.policy;
    return { name: initialChore?.name ?? incomingValue?.title ?? '', interval: calendarInput?.interval ?? (configuration ? String(configuration.intervalDays) : ''), monthly: calendarInput?.monthly ?? configuration?.monthly === true,
      preset: (policy?.completion === 'perMember' ? 'eachMember' : policy?.assignment.rotation ? 'rotation' : policy?.assignment.mode === 'selected' ? 'assigned' : policy || calendarDate ? 'common' : '') as V2ResponsibilityPreset,
      memberIds: [...(policy?.assignment.rotation?.sequence ?? policy?.assignment.memberIds ?? [])], advanceOn: policy?.assignment.rotation?.advanceOn ?? 'completion' as SharedChoreRotation['advanceOn'],
      startDate: incomingValue?.startDate ?? calendarDate ?? model?.plan.range.asOfDate ?? '', endDate: incomingValue?.endDate ?? calendarDate ?? model?.plan.range.asOfDate ?? '',
      allDay: incomingValue?.allDay ?? false, startMinute: incomingClocks?.start ?? 540, endMinute: incomingClocks?.end ?? 600, clocks: incomingClocks ?? emptyChoreClocks(), ...initialCustomChoreOptions,
      ...(initialChore ? { before: String(configuration?.windowBeforeDays ?? 0), after: String(configuration?.windowAfterDays ?? 0), minutes: String(initialChore.estimatedMinutes ?? 15), load: initialChore.load, steps: initialChore.instructions?.join('\n') ?? '' } : {}),
      ...calendarInput?.options, ...(calendarInput?.group ? { preset: calendarInput.group.preset, memberIds: [...calendarInput.group.memberIds], advanceOn: calendarInput.group.advanceOn } : {}) };
  });
  const [repeat, setRepeat] = useState(calendarInput?.repeat ?? (Boolean(initialChore) || !calendarDate)); const repeatInput = useRef(repeat);
  const [atOpen] = useState(() => ({ draft, repeat }));
  const [pickerOpen, setPickerOpen] = useState(Boolean(calendarDate && !initialChore && !calendarInput));
  const [existing, setExisting] = useState<CalendarChoreChoice | null>(initialChore ?? null); const existingInput = useRef(existing);
  const hasChoice = useRef(Boolean(calendarInput));
  const input = useRef(draft); const pending = useRef(false); const alive = useRef(true);
  const durable = useRef<SavedChore | null>(null); const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const changed = repeat !== atOpen.repeat || (draft !== atOpen.draft && JSON.stringify(draft) !== JSON.stringify(atOpen.draft));
  const allowSavedExit = useChoreDraftExit(!renderCalendarForm && !createdId && changed, !renderCalendarForm && saving, pending);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const edit = (patch: Partial<typeof draft>) => { if (pending.current || busy || durable.current) return; input.current = { ...input.current, ...patch }; setDraft(input.current); setError(null); };
  const openSaved = (saved: SavedChore, date: LocalDate) => {
    if (!alive.current) return;
    if (!renderCalendarForm) allowSavedExit();
    onCreated(saved.id, date, saved.needsDateApproval);
  };
  const create = async () => {
    if (pending.current || busy) return; pending.current = true; setSaving(true); onBusyChange?.(true); setError(null);
    try {
      if (durable.current) {
        openSaved(durable.current, input.current.startDate as LocalDate);
        return;
      }
      if (calendarDate && !administrator) throw new Error('家事の登録は管理者が行います。');
      const value = input.current;
      const name = v2ChoreDetailCodecs.name.parse(value.name) as string;
      const once = Boolean(calendarDate && !repeatInput.current);
      if (once && !singleSupported) throw new Error('この登録方法を使うには、グループの更新が必要です。');
      const configured = administrator ? customChoreInput(name, once ? 1 : value.monthly ? 30 : value.interval) : null;
      if (configured && !value.preset) throw new Error('担当を選んでください。');
      const policy = configured && value.preset ? chorePolicyFromPreset(value.preset, value.memberIds, value.advanceOn) : null;
      const steps = v2ChoreDetailCodecs.instructions.parse(value.steps) as string[];
      let saved: SavedChore | undefined;
      await run(async () => {
        const selected = existingInput.current;
        const timing = calendarDate ? choreCalendarTiming(withChoreClocks(calendarDraft(value), value.clocks)) : undefined;
        const options = parsedCustomChoreOptions(calendarDate ? { ...value, holidayPriority: false, before: '0', after: String(timing!.endDayOffset) } : value);
        const operations = selected && configured && policy ? await actions.configureChore(selected.id, {
          policy, intervalDays: configured.intervalDays, ...(once ? { once: true } : value.monthly ? { monthly: true } : {}),
          anchorDate: value.startDate as LocalDate, effectiveFrom: once || value.startDate as LocalDate > model!.plan.range.asOfDate ? value.startDate as LocalDate : model!.plan.range.asOfDate,
          active: true, windowBeforeDays: options.windowBeforeDays, windowAfterDays: options.windowAfterDays,
        }, { expectedRuleVersion: model?.configurations.find(row => row.choreId === selected.id)?.configuration?.ruleVersion ?? 0, ...(timing ? { calendarTiming: timing } : {}) })
          : configured && policy ? await actions.addConfiguredChore(configured.name, configured.intervalDays, policy, { ...options, startDate: value.startDate as LocalDate, ...(timing ? { calendarTiming: timing } : {}), ...(once ? { once: true } : value.monthly ? { monthly: true } : {}) }) : await actions.addChore(name, steps);
        const created = selected?.id ?? operations[0]?.entityId;
        if (created) {
          saved = { id: created, needsDateApproval: operations.some(operation => operation.entityType === 'changeRequest') };
          durable.current = saved;
          if (alive.current) setCreatedId(created);
        }
      });
      if (saved) openSaved(saved, value.startDate as LocalDate);
    } catch (cause) { if (alive.current) setError(durable.current ? '端末に追加済みです。もう一度開いてください。'
      : cause instanceof Error ? cause.message : '追加する内容を確認してください。'); }
    finally { pending.current = false; if (alive.current) setSaving(false); onBusyChange?.(false); }
  };
  const chooseExisting = (chore: CalendarChoreChoice) => {
    if (pending.current || busy || durable.current || !calendarDate) return;
    const config = model?.configurations.find(row => row.choreId === chore.id);
    if (!config?.configuration && config?.candidates.length) { setPickerOpen(false); setError('この家事の設定が競合しています。先に共通設定を確認してください。'); return; }
    if (chore.enabled && config?.configuration?.active !== false && config?.configuration && (!config.configuration.once || config.configuration.anchorDate === input.current.startDate)) {
      if (onOpenScheduled?.(chore.id, input.current.startDate as LocalDate, { ...readInput(), selections: { group: chore.id }, recipeId: model ? sharedRecipeId(model.plan.groupId, chore.id) : undefined }) !== false) setPickerOpen(false); return;
    }
    hasChoice.current = true; existingInput.current = chore; setExisting(chore); setPickerOpen(false);
    selections.current = { group: chore.id };
    edit({ name: chore.name, interval: String(chore.frequencyDaysByMode?.balanced ?? 7), minutes: String(chore.estimatedMinutes ?? 15), load: chore.load, steps: chore.instructions?.join('\n') ?? '' });
  };
  const chooseNew = () => { if (pending.current || busy || durable.current) return; hasChoice.current = true; existingInput.current = null; setExisting(null); selections.current = { group: null }; setPickerOpen(false); edit({ name: '', interval: '', ...initialCustomChoreOptions }); };
  if (pickerOpen && model) return <CalendarChorePicker chores={model.plan.chores} onSelect={chooseExisting} onNew={chooseNew} onClose={() => { if (hasChoice.current) setPickerOpen(false); else onBack(); }} />;
  const ready = customChoreReady(draft.name, administrator && repeat && !draft.monthly ? draft.interval : 1)
    && (!administrator || Boolean(draft.preset) && (!['assigned', 'rotation'].includes(draft.preset) || draft.memberIds.length > 0));
  const disabled = busy || saving || !createdId && !ready || Boolean(calendarDate && (!administrator || !repeat && !singleSupported));
  const unavailable = calendarDate && !administrator ? '家事の登録は管理者が行えます。'
    : calendarDate && !repeat && !singleSupported ? '1回だけの登録を使うには、共有グループを更新してください。' : null;
  const feedback = error || unavailable ? <View style={{ gap: 8, paddingVertical: 8 }}><Text accessibilityRole="alert" style={styles.error}>{error ?? unavailable}</Text>
    {calendarDate && administrator && !repeat && !singleSupported && model ? <SettingsAction title="共有グループの更新を開く" intent="auxiliary" onPress={() => router.push({ pathname: '/sharing/group/[groupId]', params: { groupId: model.plan.groupId, section: 'sync' } })} /> : null}</View> : null;
  const responsibility = <V2ResponsibilityChoices members={members} preset={draft.preset} memberIds={draft.memberIds} disabled={busy || saving || Boolean(createdId)}
    onPreset={preset => edit({ preset, ...(preset === 'rotation' ? { memberIds: members.map(member => member.userId), advanceOn: 'completion' } : {}) })}
    onMember={(userId, checked) => edit({ memberIds: checked ? [...input.current.memberIds.filter(id => id !== userId), userId] : input.current.memberIds.filter(id => id !== userId) })} />;
  function calendarDraft(value: typeof draft) { return { ...newEventDraft(value.startDate as LocalDate, model?.plan.timeZone ?? 'Asia/Tokyo'), title: value.name,
    allDay: value.allDay, endDate: value.endDate as LocalDate, startMinute: value.startMinute, endMinute: value.endMinute }; }
  function readInput(): CalendarChoreInput {
    const value = input.current;
    return { ...calendarInput, value: calendarDraft(value), clocks: { ...value.clocks }, repeat: repeatInput.current, interval: value.interval, monthly: value.monthly, options: registrationOptions(value),
      selections: { ...selections.current, group: existingInput.current?.id ?? null }, recipeId: model && existingInput.current ? sharedRecipeId(model.plan.groupId, existingInput.current.id) : undefined,
      group: { ...calendarInput?.group, preset: value.preset, memberIds: [...value.memberIds], advanceOn: value.advanceOn } };
  }
  const entry = { id: existing?.id ?? 'new', value: calendarDraft(draft), readInput,
    clocks: { ...draft.clocks, onChange: (field: 'start' | 'end', minute: number) => {
      const next = changeChoreClock(calendarDraft(input.current), input.current.clocks, field, minute);
      edit({ clocks: next.clocks, startMinute: next.value.startMinute, endMinute: next.value.endMinute, endDate: next.value.endDate });
    } },
    onChoose: () => { if (!pending.current && !busy) setPickerOpen(true); },
    titleEditable: !existing, onChange: (value: ReturnType<typeof newEventDraft>) => edit({ name: value.title, startDate: value.startDate, endDate: value.endDate, allDay: value.allDay, startMinute: value.startMinute, endMinute: value.endMinute }),
    details: <>
      {responsibility}
      <View style={{ paddingVertical: 8, minHeight: 52, borderBottomWidth: repeat ? 1 : 0, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={styles.label}>繰り返す</Text>
        <SettingsCheckbox accessibilityLabel="追加する家事を繰り返す" value={repeat} disabled={busy || saving || Boolean(createdId)} onValueChange={value => { repeatInput.current = value; setRepeat(value); onRepeatChange?.(value, calendarDraft(input.current), input.current.clocks, readInput()); }} /></View>
      {repeat ? <><V2ChoreCadence today={model?.plan.range.asOfDate ?? draft.startDate as LocalDate} anchor={draft.startDate as LocalDate} interval={draft.interval} monthly={draft.monthly}
        accessibilityLabel="追加する家事の周期" disabled={busy || saving || Boolean(createdId)} onInterval={interval => edit({ interval })} onMonthly={monthly => edit({ monthly })} onAnchor={startDate => edit({ startDate, ...(calendarDate ? { endDate: addDays(startDate, daysBetween(input.current.startDate as LocalDate, input.current.endDate as LocalDate)) } : {}) })} />
        {!renderCalendarForm ? <V2ConfigurationDates today={model?.plan.range.asOfDate ?? draft.startDate as LocalDate} anchor={draft.startDate} monthly={draft.monthly} onAnchor={startDate => edit({ startDate })} disabled={busy || saving || Boolean(createdId)} /> : null}</> : null}
      {existing && !renderCalendarForm ? <View style={{ minHeight: 60, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><Text style={styles.body}>実施期間の幅</Text><View style={{ flexDirection: 'row', gap: 5 }}>{(['before', 'after'] as const).map((key, index) =>
        <NumberInputField key={key} borderless inputWidth={24} prefix={index ? '後' : '前'} accessibilityLabel={`追加する家事の期間の${index ? '後' : '前'}`} value={draft[key]} editable={!busy && !saving && !createdId} onChangeText={text => edit({ [key]: text })} />)}</View></View>
        : (!renderCalendarForm || repeat && !existing) ? <CustomChoreOptionsFields shared showWindow={!renderCalendarForm} value={draft} onChange={edit} disabled={busy || saving || Boolean(createdId)} /> : null}
      {draft.preset === 'rotation' && model ? <V2RotationSettings members={members} value={{ sequence: draft.memberIds, advanceOn: draft.advanceOn }} disabled={busy || saving || Boolean(createdId)}
        onChange={update => { const next = update({ sequence: input.current.memberIds, advanceOn: input.current.advanceOn }); edit({ memberIds: next.sequence, advanceOn: next.advanceOn }); }} /> : null}
      {!existing && (!renderCalendarForm || repeat) ? <CustomChoreStepsField value={draft.steps} onChange={steps => edit({ steps })} disabled={busy || saving || Boolean(createdId)} /> : null}
    </> };
  const content = <>{header}
    <Text style={styles.caption}>グループ全員に公開します。</Text>
    {!administrator ? <Text style={styles.caption}>周期・担当の設定は管理者が行います。</Text> : null}
    {calendarDate && (!existing || !administrator) ? <SettingsAction title="既存の家事を選ぶ" disabled={busy || Boolean(createdId)} onPress={() => setPickerOpen(true)} /> : null}
      {administrator ? <>
        <SectionHeading title="必須" level="subsection" /><SettingsPanel>
        {existing ? <Pressable accessibilityRole="button" accessibilityLabel="追加する家事を選び直す" disabled={busy || Boolean(createdId)} onPress={() => setPickerOpen(true)}
          style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 }}><Text style={[styles.label, { flex: 1 }]}>{existing.name}</Text><Chevron /></Pressable> : <CustomChoreFields name={draft.name} interval={draft.interval} onName={name => edit({ name })} onInterval={interval => edit({ interval })} disabled={busy || Boolean(createdId)}
          cadenceField={calendarDate ? <View /> : <V2ChoreCadence today={model?.plan.range.asOfDate ?? draft.startDate as LocalDate} anchor={draft.startDate as LocalDate}
            interval={draft.interval} monthly={draft.monthly} accessibilityLabel="追加する家事の周期" disabled={busy || Boolean(createdId)}
            onInterval={interval => edit({ interval })} onMonthly={monthly => edit({ monthly })} onAnchor={startDate => edit({ startDate })} />} />}
        {calendarDate ? <>
          <View style={{ paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}><Text style={styles.label}>実施日</Text>
            <CalendarField borderless hideLabel label="家事の実施日" date={draft.startDate as LocalDate} mode="date" minute={0} commitOnDone disabled={busy || Boolean(createdId)} onDate={startDate => edit({ startDate })} /></View>
          <View style={{ paddingVertical: 8, minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={styles.label}>繰り返す</Text>
            <SettingsCheckbox accessibilityLabel="追加する家事を繰り返す" value={repeat} disabled={busy || Boolean(createdId)} onValueChange={value => { repeatInput.current = value; setRepeat(value); }} /></View>
          {repeat ? <V2ChoreCadence today={model?.plan.range.asOfDate ?? draft.startDate as LocalDate} anchor={draft.startDate as LocalDate} interval={draft.interval} monthly={draft.monthly}
            accessibilityLabel="追加する家事の周期" disabled={busy || Boolean(createdId)} onInterval={interval => edit({ interval })} onMonthly={monthly => edit({ monthly })} onAnchor={startDate => edit({ startDate })} /> : null}
        </> : null}
        {responsibility}
        </SettingsPanel>{feedback}{!existing || draft.preset === 'rotation' ? <><SectionHeading title="任意" level="subsection" /><SettingsPanel>
        {!existing ? <CustomChoreOptionsFields shared value={draft} onChange={edit} disabled={busy || Boolean(createdId)} /> : null}
        {model && !calendarDate ? <V2ConfigurationDates today={model.plan.range.asOfDate} anchor={draft.startDate} monthly={draft.monthly} onAnchor={startDate => edit({ startDate })} disabled={busy || Boolean(createdId)} /> : null}
        {draft.preset === 'rotation' ? <V2RotationSettings members={members} value={{ sequence: draft.memberIds, advanceOn: draft.advanceOn }} disabled={busy || Boolean(createdId)}
          onChange={update => { if (input.current.preset !== 'rotation') return;
            const value = update({ sequence: input.current.memberIds, advanceOn: input.current.advanceOn }); edit({ memberIds: value.sequence, advanceOn: value.advanceOn }); }} /> : null}
        {!existing ? <CustomChoreStepsField value={draft.steps} onChange={steps=>edit({steps})} disabled={busy || Boolean(createdId)} /> : null}
        </SettingsPanel></> : null}
      </> : <><SectionHeading title="必須" level="subsection" /><SettingsPanel>
        <V2TextField label="追加する共有家事の名前" value={draft.name} maxLength={500} editable={!busy && !createdId} onChangeText={name => edit({ name })} />
      </SettingsPanel>{feedback}<SectionHeading title="任意" level="subsection" /><SettingsPanel>
        <V2TextField label="追加する手順（1行に1手順）" value={draft.steps} multiline editable={!busy && !createdId} onChangeText={steps => edit({ steps })} />
      </SettingsPanel></>}
  </>;
  return renderCalendarForm ? <CalendarSheetContent render={renderCalendarForm} form={{ content: feedback, entry, onSave: () => void create(), disabled, busy: busy || saving,
    hasInput: Boolean(existing) || changed }} />
    : <V2FormScrollView contentContainerStyle={{ padding: 18, gap: 12, paddingBottom: 16 }} header={<ChoreAddHeader disabled={busy || saving} onBack={() => { if (!pending.current) onBack(); }} />}
      footer={<><AppButton title={createdId ? '追加済みの家事を開く' : '追加'} accessibilityLabel={createdId ? undefined : administrator ? '追加' : 'この内容を共有家事に追加'} disabled={disabled} onPress={() => void create()} /></>}>{content}</V2FormScrollView>;
}
