import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Text, View, useColorScheme } from 'react-native';
import { AppButton, Card, SectionHeading } from '../../../components/planner-ui';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { canonicalJson } from '../operations';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import { V2ActionConfirmationError } from '../v2/actions';
import type { V2RoundReference } from '../v2/actions';
import { v2DateChangeOriginal } from '../v2/date-change-original';
import type { DateTarget, DesignationMode, RuleSelector } from '../v2/model';
import type { CalendarConflict } from '../v2/private-availability';
import { V2Choices, V2Flag, V2TextField, V2TimeDisambiguation, v2FormStyles as styles } from './form-controls';
import { v2InitialTargetFields, v2LocalTimeChoices, v2RuleSelectorFromForm, v2TargetFromEditedForm, v2TargetLabel } from './target-form';
import type { V2ValidityChoice } from './target-form';
import { V2DateTargetFields } from './date-target-fields';
import { V2DateConfirmation } from './date-confirmation';
import { CalendarField } from '../../calendar/calendar-field';
import { SettingsAction, SettingsPanel } from '../../../components/settings-controls';
import type { LocalDate } from '../../../domain/shared/types';
import { CalendarSheetContent, type CalendarSheetForm } from '../../calendar/calendar-sheet-header';
import { newEventDraft, minuteLabel, type EventDraft } from '../../calendar/events';
import { addDays, daysBetween } from '../../../domain/scheduling/local-date';
import { v2MemberLabels } from './member-labels';
import { SettingsCheckbox } from '../../../components/settings-checkbox';
import { changeChoreClock, emptyChoreClocks, withChoreClocks, type ChoreClocks } from '../../calendar/chore-clock-input';
import type { CalendarChoreInput } from '../../calendar/chore-registration-input';
import { initialCustomChoreOptions } from '../../chores/custom-chore-options';
import { sharedRecipeId } from '../v2/standard-catalog';

const ruleIdsOf = (formal: V2SubjectPlan['formalDate']) => formal.kind === 'automatic' ? [] : formal.kind === 'manual' ? formal.equivalentRuleIds : formal.ruleIds;
const sameIds = (a: readonly string[], b: readonly string[]) => canonicalJson([...a].sort()) === canonicalJson([...b].sort());
type ConfirmationKind = 'recentWork' | 'highLoad' | 'calendar' | 'cancel';
export type V2DateFormProps = { model: V2GroupScreenModel; round: V2PlannedOccurrence; subject: V2SubjectPlan; actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>; readOwnCalendar?: (target: DateTarget) => Promise<CalendarConflict>; initialDate?: LocalDate; onSaved?(date?: LocalDate): void;
  renderCalendarForm?(form: CalendarSheetForm): ReactNode; onBusyChange?(busy: boolean): void; onRepeatChange?(repeat: boolean, value?: EventDraft, clocks?: ChoreClocks, input?: CalendarChoreInput): void; calendarValue?: EventDraft; calendarClocks?: ChoreClocks; calendarInput?: CalendarChoreInput };
type Props = V2DateFormProps;
function calendarDateFields(value: EventDraft) {
  return { mode: value.allDay && value.startDate === value.endDate ? 'day' as const : 'fixed' as const,
    fields: { day: value.startDate, clock: value.allDay ? '00:00' : minuteLabel(value.startMinute),
      endDay: value.allDay ? addDays(value.endDate, 1) : value.endDate, endClock: value.allDay ? '00:00' : minuteLabel(value.endMinute), clockChoice: '', endClockChoice: '' } };
}
function calendarInputFields(value: EventDraft, clocks: ChoreClocks) {
  return calendarDateFields({ ...value, allDay: value.allDay || clocks.start === null || clocks.end === null,
    startMinute: clocks.start ?? 0, endMinute: clocks.end ?? 0 });
}
function fieldsOnDate(fields: ReturnType<typeof v2InitialTargetFields>, date: LocalDate) {
  const offset = daysBetween(fields.day as LocalDate, date);
  return { ...fields, day: date, endDay: addDays(fields.endDay as LocalDate, offset),
    ...(offset ? { clockChoice: '', endClockChoice: '' } : {}) };
}
function shortcutClockIssue(date: string, clock: string, timeZone: string): 'ambiguous' | 'missing' | null {
  if (!/^\d{2}:\d{2}$/u.test(clock)) return null;
  try { return v2LocalTimeChoices(date, clock, timeZone).length > 1 ? 'ambiguous' : null; }
  catch (cause) { return cause instanceof Error && cause.message.includes('存在しない時刻') ? 'missing' : null; }
}
function displayedState({ model, round, subject }: Props) {
  const formal = subject.formalDate;
  const ruleIds = ruleIdsOf(formal);
  const rules = model.dateRules.filter((fact) => ruleIds.includes(fact.operationId));
  const target: DateTarget = formal.kind === 'manual' ? formal.target : { precision: 'date', date: round.anchorDate };
  const mode: DesignationMode = formal.kind === 'manual' ? formal.mode : rules.length === 1 ? rules[0].rule.mode : 'day';
  const ref: V2RoundReference = { choreId: round.choreId, anchorDate: round.anchorDate, ruleVersion: round.ruleVersion, subjectUserId: subject.subjectUserId,
    expectedConfigurationIds: model.configurations.find((entry) => entry.choreId === round.choreId)?.candidates.map((entry) => entry.operationId), expectedTimeZone: model.plan.timeZone };
  let originalMissingTime = false;
  try { const source = v2DateChangeOriginal(rules.map((fact) => fact.rule), round, model.plan.timeZone); originalMissingTime = source.originalMissingTime && source.originalReferenceAt === null; } catch { /* Changed recurrence and timezone stay explicit reviews. */ }
  return { ref, ruleIds, rules, target, mode, originalMissingTime, originalTimeZone: formal.kind === 'manual' ? formal.timeZone : model.plan.timeZone,
    timeZone: model.plan.timeZone, assignees: [...subject.assigneeIds],
    assignmentIds: [...round.assignmentOperationIds], conflictIds: [...round.assignmentConflictIds], claimIds: [...round.claimOperationIds], reviewIds: [...subject.requestReviewIds],
    needsReview: formal.kind === 'conflict' || formal.kind === 'review' || subject.requestReviewIds.length > 0,
    fields: v2InitialTargetFields(target, model.plan.timeZone),
    options: { strict: rules.some((fact) => fact.rule.strict), adminLocked: rules.some((fact) => fact.rule.adminLocked), forbidEarlier: rules.some((fact) => fact.rule.forbidEarlier) } };
}

/** Date changes are explicit signed commands. Typing never changes an existing formal schedule. */
export function V2DateForm(props: Props) {
  return <DateEditor key={`${props.round.id}:${props.subject.id}`} {...props} />;
}
function DateEditor(props: Props) {
  const colors = plannerColorsForScheme(useColorScheme());
  const { model, round, subject, actions, busy, run, readOwnCalendar } = props;
  const initialCalendarValue = props.calendarInput?.value ?? props.calendarValue; const initialClocks = props.calendarInput?.clocks ?? props.calendarClocks ?? emptyChoreClocks();
  const [displayed] = useState(() => displayedState(props));
  const [draft, setDraft] = useState(() => ({ mode: displayed.mode, fields: props.initialDate ? fieldsOnDate(displayed.fields, props.initialDate) : displayed.fields,
    ...(initialCalendarValue ? calendarInputFields(initialCalendarValue, initialClocks) : {}), validity: 'once' as V2ValidityChoice,
    through: '', extension: 'once' as 'once' | 'future', options: displayed.options, reviewed: false }));
  const input = useRef(draft);
  const [calendarValue, setCalendarValue] = useState(initialCalendarValue);
  const calendarInput = useRef(calendarValue);
  const [clocks, setClocks] = useState(initialClocks); const clockInput = useRef(clocks);
  const [assigneeIds, setAssigneeIds] = useState(props.calendarInput?.group?.onceAssigneeIds ?? displayed.assignees); const assigneeInput = useRef(assigneeIds);
  const { mode, fields, validity, through, extension, options, reviewed } = draft;
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: ConfirmationKind; revision: number } | null>(null);
  const inputRevision = useRef(0);
  const [cancelScope, setCancelScope] = useState({ validity: 'once' as V2ValidityChoice | 'source', through: '' });
  const cancelInput = useRef(cancelScope);
  const editCancelScope = (patch: Partial<typeof cancelScope>) => {
    if (inFlight.current) return;
    cancelInput.current = { ...cancelInput.current, ...patch }; setCancelScope(cancelInput.current);
    inputRevision.current++; setConfirmation({ kind: 'cancel', revision: inputRevision.current }); setError(null);
  };
  const askConfirmation = (kind: ConfirmationKind) => setConfirmation({ kind, revision: inputRevision.current });
  const [calendarStatus, setCalendarStatus] = useState<'unknown' | 'clear' | 'conflict'>('unknown');
  const [success, setSuccess] = useState<string | null>(null); const [saving, setSaving] = useState(false); const inFlight = useRef(false);
  const confirmed = useRef({ recentWork: false, highLoad: false, calendar: false });
  const zoneChanged = displayed.timeZone !== model.plan.timeZone;
  const staleAssignment = !sameIds(displayed.assignees, subject.assigneeIds) || !sameIds(displayed.assignmentIds, round.assignmentOperationIds) || !sameIds(displayed.conflictIds, round.assignmentConflictIds)
    || Boolean(props.renderCalendarForm && !sameIds(displayed.claimIds, round.claimOperationIds));
  const staleDate = !sameIds(displayed.ruleIds, ruleIdsOf(subject.formalDate)) || !sameIds(displayed.reviewIds, subject.requestReviewIds);
  const staleConfiguration = !sameIds(displayed.ref.expectedConfigurationIds ?? [], model.configurations.find((entry) => entry.choreId === round.choreId)?.candidates.map((entry) => entry.operationId) ?? []);
  const stale = zoneChanged || staleAssignment || staleDate || staleConfiguration;
  const disabled = busy || saving || stale || !model.plan.initialized || Boolean(success)
    || !round.activeInPeriod || Boolean(round.assignmentConflictIds.length) || !model.plan.members.some((member) => member.active && member.userId === model.viewerUserId);
  const admin = model.viewerUserId === model.adminUserId;
  const unavailable = !round.activeInPeriod ? 'この回は実施期間外です。家事を選び直してください。'
    : round.assignmentConflictIds.length ? '担当が競合しています。担当の設定を確認してください。'
    : !model.plan.members.some(member => member.active && member.userId === model.viewerUserId) ? 'グループの参加状態を確認してください。' : null;
  const ownCalendar = (props.renderCalendarForm ? assigneeIds : displayed.assignees).includes(model.viewerUserId) ? readOwnCalendar : undefined;
  const edit = (patch: Partial<typeof draft>) => {
    if (inFlight.current) return;
    inputRevision.current++; input.current = { ...input.current, ...patch }; setDraft(input.current);
    setCalendarStatus('unknown'); setConfirmation(null); setError(null); confirmed.current = { recentWork: false, highLoad: false, calendar: false };
  };
  const field = (name: keyof typeof fields, value: string) => {
    const returnedToSourceDate = name === 'day' && value === displayed.fields.day;
    const dateShifted = name === 'day' && Boolean(props.initialDate) && value !== input.current.fields.day && !returnedToSourceDate;
    const next = returnedToSourceDate ? { ...displayed.fields } : { ...input.current.fields, [name]: value,
      ...(['day', 'clock'].includes(name) ? { clockChoice: '' } : ['endDay', 'endClock'].includes(name) ? { endClockChoice: '' } : {}) };
    if (dateShifted) {
      try {
        const offset = daysBetween(displayed.fields.day as LocalDate, value as LocalDate);
        next.endDay = addDays(displayed.fields.endDay as LocalDate, offset);
      } catch { /* Keep the previous end date while the user is entering an incomplete date. */ }
      next.endClockChoice = '';
    }
    edit({ fields: next });
  };
  const submit = async () => {
    if (disabled || inFlight.current) return;
    const { validity, through, extension, options, reviewed } = input.current;
    let { mode, fields } = input.current;
    setError(null); let target: DateTarget; let selector: RuleSelector;
    try {
      if (props.renderCalendarForm && calendarInput.current) ({ mode, fields } = calendarDateFields(withChoreClocks(calendarInput.current, clockInput.current)));
      if (displayed.needsReview && !reviewed) throw new Error('元の指定と競合している内容を確認してください。');
      target = v2TargetFromEditedForm({ mode, ...fields, timeZone: displayed.timeZone, clockChoice: fields.clockChoice || undefined,
        endClockChoice: fields.endClockChoice || undefined }, displayed.target, displayed.fields);
      selector = v2RuleSelectorFromForm(validity, round, through);
      const rank = (scope: string) => scope === 'once' ? 3 : scope === 'period' ? 2 : 1;
      if (displayed.rules.some((fact) => rank(fact.rule.selector.scope) > rank(selector.scope)) && canonicalJson(target) !== canonicalJson(displayed.target)) {
        throw new Error('この回の個別指定が優先されます。今回だけを選んで変更するか、元の指定を解除してから期間を指定してください。');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '変更する日時を確認してください。'); return; }
    inFlight.current = true; setSaving(true); props.onBusyChange?.(true);
    let savedDirectly = false;
    try { await run(async () => {
      const chosenCalendar = (props.renderCalendarForm ? assigneeInput.current : displayed.assignees).includes(model.viewerUserId) ? readOwnCalendar : undefined;
      if (mode === 'fixed' && chosenCalendar && !confirmed.current.calendar) {
        const reading = await chosenCalendar(target); setCalendarStatus(reading.kind);
        if (reading.kind === 'conflict') { askConfirmation('calendar'); return; }
      }
      try {
        const created = await actions.changeDate(displayed.ref, { mode, target, selector, options, extensionScope: extension,
          expectedRuleIds: displayed.ruleIds, confirmDateConflict: reviewed, reviewedRequestIds: displayed.reviewIds,
          expectedAssigneeIds: displayed.assignees, expectedAssignmentIds: displayed.assignmentIds, expectedConflictIds: displayed.conflictIds,
          ...(props.renderCalendarForm ? { ...(admin && subject.subjectUserId === null ? { assigneeIds: assigneeInput.current } : {}), expectedClaimIds: displayed.claimIds } : {}),
          expectedRequestReviewIds: displayed.reviewIds, confirmRecentWork: confirmed.current.recentWork, confirmHighLoad: confirmed.current.highLoad });
        setSuccess(created[0]?.entityType === 'changeRequest' ? '変更申請を端末に保存しました。受付と必要な承認の確認まで正式予定は変わりません。'
          : '日時指定を端末に保存しました。他のメンバーへの反映状況は同期表示で確認できます。'); setConfirmation(null);
        savedDirectly = created[0]?.entityType !== 'changeRequest';
      } catch (cause) {
        if (cause instanceof V2ActionConfirmationError) { askConfirmation(cause.reason); return; } throw cause;
      }
    }); if (savedDirectly) props.onSaved?.(input.current.fields.day as LocalDate); }
    catch (cause) { if (!props.renderCalendarForm) throw cause; setError(cause instanceof Error ? cause.message : '変更を保存できませんでした。'); }
    finally { inFlight.current = false; setSaving(false); props.onBusyChange?.(false); }
  };
  const cancel = async (revision: number) => {
    if (revision !== inputRevision.current) { setConfirmation(null); return; }
    if (disabled || inFlight.current) return;
    let selector: RuleSelector | undefined;
    try {
      const current = cancelInput.current;
      selector = current.validity === 'source' ? undefined : v2RuleSelectorFromForm(current.validity, round, current.through);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '解除する範囲を確認してください。'); return; }
    inFlight.current = true; setSaving(true); props.onBusyChange?.(true);
    try { await run(async () => { const created = await actions.cancelDates(displayed.ref, displayed.ruleIds, { expectedRuleIds: displayed.ruleIds, selector,
      expectedAssigneeIds: displayed.assignees, expectedAssignmentIds: displayed.assignmentIds, expectedConflictIds: displayed.conflictIds });
      setSuccess(created[0]?.entityType === 'changeRequest' ? '解除申請を端末に保存しました。受付と必要な承認の確認まで正式予定は変わりません。'
        : '選択した範囲の日時指定を解除しました。実施履歴は保持されています。'); setConfirmation(null); }); }
    finally { inFlight.current = false; setSaving(false); props.onBusyChange?.(false); }
  };
  const clockMinute = (clock: string, fallback: number) => /^\d{2}:\d{2}$/u.test(clock) ? Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)) : fallback;
  const readInput = (): CalendarChoreInput => {
    const chore = model.plan.chores.find(row => row.id === round.choreId); const cfg = model.configurations.find(row => row.choreId === round.choreId)?.configuration;
    const policy = cfg?.policy;
    return { ...props.calendarInput, value: { ...(calendarInput.current ?? newEventDraft(input.current.fields.day as LocalDate, displayed.timeZone)), title: chore?.name ?? '' },
      clocks: { ...clockInput.current }, repeat: false, interval: props.calendarInput?.interval ?? String(cfg?.intervalDays ?? 7), monthly: props.calendarInput?.monthly ?? cfg?.monthly === true,
      options: { ...initialCustomChoreOptions, minutes: String(chore?.estimatedMinutes ?? 15), load: chore?.load ?? 'normal', ...props.calendarInput?.options },
      selections: { ...props.calendarInput?.selections, group: round.choreId }, recipeId: sharedRecipeId(model.plan.groupId, round.choreId),
      group: { preset: policy?.completion === 'perMember' ? 'eachMember' : policy?.assignment.rotation ? 'rotation' : policy?.assignment.mode === 'selected' ? 'assigned' : 'common',
        memberIds: [...(policy?.assignment.rotation?.sequence ?? policy?.assignment.memberIds ?? [])], advanceOn: policy?.assignment.rotation?.advanceOn ?? 'completion', ...props.calendarInput?.group, onceAssigneeIds: [...assigneeInput.current] } };
  };
  const entry = { value: calendarValue ?? { ...newEventDraft(fields.day as LocalDate, displayed.timeZone), allDay: mode !== 'fixed', endDate: (fields.endDay || fields.day) as LocalDate,
      startMinute: clockMinute(fields.clock, 540), endMinute: clockMinute(fields.endClock, 600) }, titleEditable: false,
    readInput,
    onChange: (value: ReturnType<typeof newEventDraft>) => { if (inFlight.current) return; calendarInput.current = value; setCalendarValue(value);
      edit(calendarInputFields(value, clockInput.current)); },
    clocks: { ...clocks, onChange: (field: 'start' | 'end', minute: number) => {
      if (inFlight.current || !calendarInput.current) return;
      const next = changeChoreClock(calendarInput.current, clockInput.current, field, minute);
      clockInput.current = next.clocks; setClocks(next.clocks); calendarInput.current = next.value; setCalendarValue(next.value);
      edit(calendarInputFields(next.value, next.clocks));
    } },
    details: <View style={{ gap: 12 }}><View style={{ gap: 8, paddingBottom: 12, borderBottomWidth: props.onRepeatChange ? 1 : 0, borderBottomColor: colors.border }}><Text style={styles.label}>担当</Text>
      {admin && subject.subjectUserId === null ? <>{model.plan.members.filter(member => member.active).map(member => <View key={member.userId} style={{ minHeight: 44, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <Text style={[styles.body, { flex: 1 }]}>{v2MemberLabels(model.plan.members)(member.userId)}</Text><SettingsCheckbox accessibilityLabel={`この回の担当：${v2MemberLabels(model.plan.members)(member.userId)}`} value={assigneeIds.includes(member.userId)}
          disabled={disabled || Boolean(displayed.claimIds.length)} onValueChange={checked => { if (inFlight.current) return;
            const next = checked ? [...assigneeInput.current.filter(id => id !== member.userId), member.userId] : assigneeInput.current.filter(id => id !== member.userId);
            assigneeInput.current = next; setAssigneeIds(next); edit({}); }} /></View>)}
        {!assigneeIds.length ? <Text style={styles.caption}>誰か1人</Text> : null}</> : <Text style={styles.body}>{displayed.assignees.map(v2MemberLabels(model.plan.members)).join('・') || '誰か1人'}</Text>}</View>
      {props.onRepeatChange ? <View style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={styles.label}>繰り返す</Text><SettingsCheckbox accessibilityLabel="追加する家事を繰り返す" value={false} disabled={disabled || !admin} onValueChange={repeat => props.onRepeatChange?.(repeat, calendarInput.current, clockInput.current, readInput())} /></View> : null}
    </View> };
  const presentation = { render: props.renderCalendarForm, onSave: submit, disabled: disabled || Boolean(confirmation), busy: busy || saving, entry };
  if (success) return <DatePresentation {...presentation} onSave={undefined}><Card><Text accessibilityLiveRegion="polite" style={styles.body}>{success}</Text></Card></DatePresentation>;
  if (!model.plan.initialized) return <DatePresentation {...presentation} onSave={undefined}><Card><Text style={styles.body}>グループの地域と基本設定が未確定です。先に設定を確認してください。</Text></Card></DatePresentation>;
  const shortcutStartIssue = props.initialDate && !props.renderCalendarForm && mode === 'fixed'
    ? shortcutClockIssue(fields.day, fields.clock, displayed.timeZone) : null;
  const shortcutEndIssue = props.initialDate && !props.renderCalendarForm && mode === 'fixed'
    ? shortcutClockIssue(fields.endDay, fields.endClock, displayed.timeZone) : null;
  if (props.initialDate && !displayed.needsReview && !round.assignmentConflictIds.length) return <DatePresentation {...presentation}><View style={{ gap: 14 }}>
    {!props.renderCalendarForm ? <Text style={styles.caption}>既存の1回だけを変更します。</Text> : null}
    {!props.renderCalendarForm ? <SettingsPanel><View style={{ paddingVertical: 10, gap: 10 }}>
      <Text style={styles.caption}>現在：{v2TargetLabel(displayed.target, displayed.originalTimeZone)}</Text>
      <CalendarField label="変更後の実施日" borderless commitOnDone="or-backdrop" date={fields.day as LocalDate} mode="date" minute={0} disabled={disabled} onDate={date => field('day', date)} />
    </View></SettingsPanel> : null}
    {shortcutStartIssue === 'ambiguous' ? <V2TimeDisambiguation label="開始時刻の区別" day={fields.day} clock={fields.clock} timeZone={displayed.timeZone}
      value={fields.clockChoice} disabled={disabled} onChange={value => field('clockChoice', value)} /> : null}
    {shortcutStartIssue === 'missing' ? <View style={{ gap: 6 }}><Text style={styles.error}>開始時刻がこの地域にはありません。別の時刻を選んでください。</Text>
      <V2TextField label="開始時刻" value={fields.clock} placeholder="HH:mm" editable={!disabled} onChangeText={value => field('clock', value)} /></View> : null}
    {shortcutEndIssue === 'ambiguous' ? <V2TimeDisambiguation label="終了時刻の区別" day={fields.endDay} clock={fields.endClock} timeZone={displayed.timeZone}
      value={fields.endClockChoice} disabled={disabled} onChange={value => field('endClockChoice', value)} /> : null}
    {shortcutEndIssue === 'missing' ? <View style={{ gap: 6 }}><Text style={styles.error}>終了時刻がこの地域にはありません。別の時刻を選んでください。</Text>
      <V2TextField label="終了時刻" value={fields.endClock} placeholder="HH:mm" editable={!disabled} onChangeText={value => field('endClock', value)} /></View> : null}
    {stale ? <Text accessibilityRole="alert" style={styles.error}>予定が更新されています。開き直して確認してください。</Text> : null}
    {unavailable ? <Text accessibilityRole="alert" style={styles.error}>{unavailable}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {confirmation && confirmation.kind !== 'cancel' ? <V2DateConfirmation kind={confirmation.kind} disabled={disabled}
      onConfirm={() => { if (confirmation.revision !== inputRevision.current) return; confirmed.current[confirmation.kind as Exclude<ConfirmationKind, 'cancel'>] = true; setConfirmation(null); void submit(); }}
      onCancel={() => setConfirmation(null)} /> : !props.renderCalendarForm ? <SettingsAction title={admin ? 'この日に変更' : '変更を申請'} intent="primary" disabled={disabled} onPress={() => void submit()} /> : null}
  </View></DatePresentation>;
  return <DatePresentation {...presentation}><Card><SectionHeading title="日時の指定・変更" />
    {stale ? <Text accessibilityRole="alert" style={styles.error}>地域・担当・日時指定または共通設定が変更されています。入力は保持しています。現在の内容を確認して開き直してください。</Text> : null}
    <Text style={styles.caption}>日時の地域：{displayed.timeZone}。基本周期と完了済みの履歴は変更しません。</Text>
    {displayed.originalTimeZone !== displayed.timeZone ? <Text style={styles.caption}>現在の指定：{v2TargetLabel(displayed.target, displayed.originalTimeZone)} · {displayed.originalTimeZone}。既存の指定は元の地域を維持します。この画面で新しく指定する日時には{displayed.timeZone}を使います。</Text> : null}
    {displayed.needsReview ? <View style={{ gap: 8 }}><Text style={styles.error}>元の指定が未確定か、回答が競合しています。内容を確認して申請してください。</Text>
      {displayed.rules.map((fact) => <Text key={fact.operationId} style={styles.caption}>元の指定：{v2TargetLabel(fact.rule.target, fact.rule.timeZoneAtCreation)} · {fact.rule.timeZoneAtCreation} · {fact.rule.selector.scope === 'once' ? '今回だけ' : '繰り返しの基準回'}</Text>)}
      {displayed.originalMissingTime ? <Text style={styles.caption}>元の時刻がこの地域には存在しないため、変更先を基準に申請期限を計算します。承認までは元の正式時刻は未確定です。</Text> : null}
      <V2Flag label="元の指定・競合内容を確認した" value={reviewed} onChange={(value) => edit({ reviewed: value })} disabled={disabled} />
    </View> : null}
    <V2Choices label="指定の種類" value={mode} onChange={(value) => edit({ mode: value })} disabled={disabled}
      choices={[{ value: 'deadline', label: '期限までに実施' }, { value: 'day', label: 'この日に実施' }, { value: 'fixed', label: '固定日時に実施' }]} />
    <V2DateTargetFields mode={mode} fields={fields} timeZone={displayed.timeZone} disabled={disabled} onChange={field} />
    {mode === 'fixed' ? <Text style={styles.caption}>Google Calendarの競合：{calendarStatus === 'clear' ? '取得済みの本人用情報の範囲では重複なし' : calendarStatus === 'conflict' ? '本人の予定と重複' : '未確認'}。{ownCalendar ? '本人用の情報で保存前に確認します。' : ''}他の人の予定内容は表示しません。</Text> : null}
    <V2Choices label="日時指定の適用範囲" value={validity} onChange={(value) => edit({ validity: value })} disabled={disabled}
      choices={[{ value: 'once', label: '今回だけ' }, { value: 'twoWeeks', label: '2週間' }, { value: 'oneMonth', label: '1か月' }, { value: 'endDate', label: '終了日を指定' }, { value: 'ongoing', label: '無期限' }]} />
    {validity === 'endDate' ? <V2TextField label="適用する最後の基準日" value={through} placeholder="YYYY-MM-DD" editable={!disabled} onChangeText={(value) => edit({ through: value })} /> : null}
    {validity !== 'once' ? <Text style={styles.caption}>今回の基準日からの日数差と現地時刻を各回へ適用します。夏時間などで確定できない回は確認が必要です。</Text> : null}
    <V2Choices label="期間外変更が承認された場合の実施可能期間" value={extension} onChange={(value) => edit({ extension: value })} disabled={disabled}
      choices={[{ value: 'once', label: '今回の実施可能期間だけ' }, { value: 'future', label: '今後の実施可能期間にも適用' }]} />
    {(['strict', 'adminLocked', 'forbidEarlier'] as const).map((key) => <V2Flag key={key} label={key === 'strict' ? '指定日時を厳守' : key === 'adminLocked' ? '管理者による固定' : '前倒しを禁止'}
      value={options[key]} disabled={disabled || !admin} onChange={(value) => edit({ options: { ...input.current.options, [key]: value } })} />)}
    {!admin ? <Text style={styles.caption}>元の厳守・固定・前倒し禁止の条件を維持して申請します。</Text> : null}
    {unavailable ? <Text accessibilityRole="alert" style={styles.error}>{unavailable}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {confirmation && confirmation.kind !== 'cancel' ? <V2DateConfirmation kind={confirmation.kind} disabled={disabled}
      onConfirm={() => { if (confirmation.revision !== inputRevision.current || confirmation.kind === 'cancel') { setConfirmation(null); return; }
        confirmed.current[confirmation.kind] = true; setConfirmation(null); return submit(); }}
      onCancel={() => { setConfirmation(null); confirmed.current = { recentWork: false, highLoad: false, calendar: false }; }} />
      : !props.renderCalendarForm ? <AppButton title="日時を指定・申請する" disabled={disabled} onPress={submit} /> : null}
    {displayed.rules.length ? <View style={{ gap: 8 }}>
      {confirmation?.kind === 'cancel' ? <><Text style={styles.error}>次の元指定から、選択した範囲だけを解除します。実施履歴は残ります。ほかの指定が残る場合はそちらを適用します。</Text>
        {displayed.rules.map((fact) => <Text key={fact.operationId} style={styles.caption}>{fact.rule.selector.scope === 'once' ? `今回だけ：${fact.rule.selector.anchorDate}`
          : fact.rule.selector.scope === 'ongoing' ? `${fact.rule.selector.from}から無期限` : `${fact.rule.selector.range.from}〜${fact.rule.selector.range.through ?? '無期限'}`}</Text>)}
        <V2Choices label="日時指定を解除する範囲" value={cancelScope.validity} onChange={(validity) => editCancelScope({ validity })} disabled={disabled}
          choices={[{ value: 'once', label: '今回だけ解除' }, { value: 'twoWeeks', label: '2週間の指定を解除' }, { value: 'oneMonth', label: '1か月の指定を解除' },
            { value: 'endDate', label: '解除の終了日を指定' }, { value: 'ongoing', label: '今回以降を解除' }, { value: 'source', label: '元指定の全期間' }]} />
        {cancelScope.validity === 'endDate' ? <V2TextField label="解除する最後の基準日" placeholder="YYYY-MM-DD" value={cancelScope.through} editable={!disabled}
          onChangeText={(through) => editCancelScope({ through })} /> : null}
        {cancelScope.validity === 'source' ? <Text style={styles.error}>表示した元指定を適用期間全体から解除する操作です。今回以外の回にも影響します。</Text> : null}
        <Text style={styles.caption}>承認が必要な場合は解除申請を保存します。承認確認までは正式予定を維持します。</Text>
        <AppButton title={cancelScope.validity === 'source' ? '表示した適用期間の指定を解除する' : '選択した範囲の指定を解除する'} disabled={disabled} onPress={() => cancel(confirmation.revision)} />
        <AppButton title="解除せず戻る" variant="quiet" disabled={disabled} onPress={() => setConfirmation(null)} /></>
        : <AppButton title="適用中の日時指定を解除…" variant="quiet" disabled={disabled} onPress={() => askConfirmation('cancel')} />}
    </View> : null}
  </Card></DatePresentation>;
}

function DatePresentation({ render, children, ...form }: Omit<CalendarSheetForm, 'content'> & { render?: Props['renderCalendarForm']; children: ReactNode }) {
  return render ? <CalendarSheetContent render={render} form={{ ...form, content: children }} /> : children;
}
