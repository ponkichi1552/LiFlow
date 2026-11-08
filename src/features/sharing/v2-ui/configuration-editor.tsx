import { SettingsCheckbox } from '@/components/settings-checkbox';
import { SettingsPanel } from '@/components/settings-controls';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';
import { BackButton, palette, typography } from '../../../components/planner-ui';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { NumberInputField } from '../../../components/number-input-field';
import type { LocalDate } from '../../../domain/shared/types';
import { parseLocalDate } from '../../../domain/scheduling/local-date';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { SharedChoreConfiguration } from '../v2/model';
import { useV2ConfigurationAutosave } from './use-configuration-autosave';
import { canonicalJson } from '../operations';
import { V2StaleSettingsError } from '../v2/configuration-edit';
import { V2InitialConfiguration } from './initial-configuration';
import { V2ConfigurationConflict } from './configuration-conflict';
import { V2AutosaveFeedback } from './autosave-feedback';
import { ScheduleResetAction } from '../../../components/schedule-reset-action';
import { V2AdvancedSettings } from './advanced-settings';
import { V2ConfigurationDates } from './configuration-dates';
import { V2ChoreCadence } from './chore-cadence';
import { V2ResponsibilityChoices } from './responsibility-choices';
import { chorePolicyFromPreset } from '../v2/model';
import { V2RotationSettings } from './rotation-settings';
import { rotationDraft } from './responsibility-policy';

/** Only an authenticated administrator receives the editor; receiver authority remains the final check. */
export function V2ConfigurationEditor(props: { model: V2GroupScreenModel; choreId: string;
  controller: V2GroupController; onSaved: () => Promise<void>; onBack?: () => void; advanced?: ReactNode; advancedNeedsReview?: boolean; onAdvanced?(): void; advancedOnly?: boolean }) {
  const { model, choreId } = props;
  if (props.advancedOnly && model.viewerUserId !== model.adminUserId) return null;
  if (model.viewerUserId !== model.adminUserId) return <View style={styles.container}>{props.onBack ? <BackButton onPress={props.onBack} /> : null}
    <Text style={styles.caption}>周期と有効状態は管理者が変更します。</Text>
    {props.onAdvanced || props.advanced ? <V2AdvancedSettings choreId={choreId} needsReview={props.advancedNeedsReview} onOpen={props.onAdvanced}>{props.advanced}</V2AdvancedSettings> : null}</View>;
  return <RetainedEditor key={`${model.plan.groupId}:${choreId}`} {...props} />;
}

function RetainedEditor({ model, choreId, controller, onSaved, onBack, advanced, advancedNeedsReview, onAdvanced, advancedOnly }: Parameters<typeof V2ConfigurationEditor>[0]) {
  const row = model.configurations.find((entry) => entry.choreId === choreId);
  const [retained, setRetained] = useState(row?.configuration ?? null);
  // Retain the editor (and its draft store) when a remote conflict temporarily removes the resolved value.
  if (row?.configuration && (!retained || row.configuration.ruleVersion >= retained.ruleVersion && canonicalJson(row.configuration) !== canonicalJson(retained))) setRetained(row.configuration);
  const configuration = row?.configuration && (!retained || row.configuration.ruleVersion >= retained.ruleVersion) ? row.configuration : retained;
  const conflict = !row?.configuration && row?.candidates.length ? <V2ConfigurationConflict model={model} row={row} controller={controller}
    onSaved={onSaved} onBack={!configuration ? onBack : undefined} /> : null;
  if (!configuration) return advancedOnly ? null : conflict
    ?? <V2InitialConfiguration model={model} choreId={choreId} controller={controller} onSaved={onSaved} onBack={onBack} advanced={advanced} advancedNeedsReview={advancedNeedsReview} onAdvanced={onAdvanced} />;
  const boundary = configuration.effectiveFrom ?? configuration.anchorDate;
  const earliestFrom = row?.earliestEffectiveFrom && row.earliestEffectiveFrom > boundary ? row.earliestEffectiveFrom : boundary;
  return <View style={styles.container}>{conflict}<Editor configuration={configuration} earliestFrom={earliestFrom}
    today={model.plan.range.asOfDate} members={model.plan.members} choreId={choreId} controller={controller} onSaved={onSaved} onBack={onBack} blocked={!row?.configuration}
    advanced={advanced} advancedNeedsReview={advancedNeedsReview} onAdvanced={onAdvanced} advancedOnly={advancedOnly} /></View>;
}

function Editor({ configuration, earliestFrom, today, members, choreId, controller, onSaved, onBack, blocked, advanced, advancedNeedsReview, onAdvanced, advancedOnly }: { configuration: SharedChoreConfiguration;
  earliestFrom: LocalDate; today: LocalDate; members: V2GroupScreenModel['plan']['members']; choreId: string; controller: V2GroupController; onSaved: () => Promise<void>; onBack?: () => void; blocked: boolean;
  advanced?: ReactNode; advancedNeedsReview?: boolean; onAdvanced?(): void; advancedOnly?: boolean }) {
  const scheme = useColorScheme(); const colors = plannerColorsForScheme(scheme);
  const rowStyle = [styles.row, { borderBottomColor: colors.border }];
  const autosave = useV2ConfigurationAutosave({ configuration, effectiveFrom: today > earliestFrom ? today : earliestFrom,
    save: (edits, date) => { if (blocked) return Promise.reject(new V2StaleSettingsError()); return controller.actions.patchChoreConfigurationFields(choreId, edits, date); }, onSaved }, `configuration:${choreId}`);
  const saving = autosave.status.phase === 'pending' || autosave.status.phase === 'saving';
  const from = autosave.effectiveFrom;
  const fromError = (() => { try { parseLocalDate(from); if (from < earliestFrom) throw new Error('Boundary'); return null; }
    catch { return `適用開始日は${earliestFrom}以降の日付にしてください。`; } })();
  const policy = autosave.draft.policy;
  const preset = policy.assignment.rotation ? 'rotation' : policy.completion === 'perMember' ? 'eachMember' : policy.assignment.mode === 'selected' ? 'assigned' : 'common';
  const rotation = policy.assignment.rotation ? <V2RotationSettings members={members} value={policy.assignment.rotation} unfolded={advancedOnly} disabled={blocked || Boolean(fromError)} onChange={update => {
    const current = autosave.getSnapshot().draft.policy.assignment.rotation; if (!current) return;
    const value = update(current); autosave.changePolicy(rotationDraft(value.sequence, value.advanceOn));
  }} /> : null;
  if (advancedOnly) return <View style={styles.container}>{rotation}
    {autosave.policyError ? <Text accessibilityRole="alert" style={styles.error}>{autosave.policyError}</Text> : null}
    <V2AutosaveFeedback concise status={autosave.status} refreshError={autosave.refreshError} hasDraft={autosave.hasDraft()} flush={autosave.flush} discard={autosave.discard} discardTitle="入力を最新の設定に戻す" />
  </View>;
  return <View style={styles.container}>
    {onBack ? <BackButton disabled={autosave.leaving} onPress={() => void autosave.navigateAfterSave(onBack)} /> : null}
    <SettingsPanel>
    {blocked ? <Text accessibilityRole="alert" style={styles.error}>設定が競合しています。入力は保持しています。候補を確認して解決するか、入力を戻してください。</Text> : null}
    <View style={rowStyle}><Text style={styles.label}>予定に追加</Text><SettingsCheckbox accessibilityLabel="共有家事を有効にする" value={autosave.draft.active}
      disabled={blocked || Boolean(fromError)} onValueChange={autosave.changeActive} /></View>
    <V2ResponsibilityChoices members={members} preset={preset} memberIds={policy.assignment.memberIds} disabled={blocked || Boolean(fromError)}
      onPreset={value => autosave.changePolicy(value === 'rotation' ? rotationDraft(members.filter(member => member.active).map(member => member.userId))
        : value === 'assigned' ? { completion: 'one', assignment: { mode: 'selected', memberIds: [] } } : chorePolicyFromPreset(value))}
      onMember={(userId, checked) => {
        const current = autosave.getSnapshot().draft.policy.assignment;
        if (current.rotation) autosave.changePolicy(rotationDraft(checked ? [...current.rotation.sequence, userId] : current.rotation.sequence.filter(id => id !== userId), current.rotation.advanceOn));
        else autosave.changePolicy({ completion: 'one', assignment: { mode: 'selected', memberIds: checked ? [...new Set([...current.memberIds, userId])].sort() : current.memberIds.filter(id => id !== userId) } });
      }} />
    {autosave.policyError ? <Text accessibilityRole="alert" style={styles.error}>{autosave.policyError}</Text> : null}
    <V2ChoreCadence today={today} anchor={autosave.draft.anchorDate} interval={autosave.draft.intervalDays} monthly={autosave.draft.monthly}
      accessibilityLabel="共有家事の周期" disabled={blocked || Boolean(fromError)} dateDisabled={blocked || saving || autosave.hasDraft()}
      onInterval={text => autosave.changeNumber('intervalDays', text)} onMonthly={autosave.changeMonthly}
      onAnchor={value => { autosave.changeAnchor(value); void autosave.flush(); }} onEndEditing={() => void autosave.flush()} />
    {autosave.numberError('intervalDays') ? <Text accessibilityRole="alert" style={styles.error}>{autosave.numberError('intervalDays')}</Text> : null}
    <View style={rowStyle}><Text style={styles.label}>実施期間の幅</Text><View style={styles.window}>
      {(['windowBeforeDays', 'windowAfterDays'] as const).map((field, index) => <NumberInputField key={field} borderless inputWidth={24} prefix={index === 0 ? '前' : '後'}
        accessibilityLabel={`共有家事の基準日より${index === 0 ? '前' : '後'}`} value={autosave.draft[field]} editable={!blocked && !fromError}
        onChangeText={text => autosave.changeNumber(field, text)} onEndEditing={() => void autosave.flush()} />)}
    </View></View>
    {(['windowBeforeDays', 'windowAfterDays'] as const).map(field => autosave.numberError(field) ? <Text key={field} accessibilityRole="alert" style={styles.error}>{autosave.numberError(field)}</Text> : null)}
    <V2AutosaveFeedback concise status={autosave.status} refreshError={autosave.refreshError} hasDraft={autosave.hasDraft()} flush={autosave.flush}
      discard={autosave.discard} discardTitle="入力を最新の設定に戻す" disabled={autosave.leaving} />
    <V2ConfigurationDates today={today} anchor={autosave.draft.anchorDate} monthly={autosave.draft.monthly} disabled={blocked || saving || autosave.hasDraft()} needsReview={Boolean(fromError || autosave.anchorError)}
      onAnchor={value => { autosave.changeAnchor(value); void autosave.flush(); }} />
    {autosave.anchorError ? <Text accessibilityRole="alert" style={styles.error}>{autosave.anchorError}</Text> : null}
    {fromError ? <Text accessibilityRole="alert" style={styles.error}>{fromError}</Text> : null}
    {onAdvanced || advanced || policy.assignment.rotation ? <V2AdvancedSettings choreId={choreId} needsReview={advancedNeedsReview} onOpen={onAdvanced}>
      {rotation}
      {advanced}</V2AdvancedSettings> : null}
    <ScheduleResetAction disabled={blocked || Boolean(fromError) || saving || autosave.hasDraft()} onReset={async () => {
      if (!await autosave.flush()) throw new Error('入力内容を確認してください。');
      await controller.actions.resetChoreSchedules([choreId], { [choreId]: configuration.ruleVersion }, from); await onSaved();
    }} />
    </SettingsPanel>
  </View>;
}
const styles = StyleSheet.create({
  container: { gap: 8 }, window: { flexDirection: 'row', gap: 6 },
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 8, borderBottomWidth: 1 },
  label: { ...typography.body, color: palette.ink, flexShrink: 1 }, caption: { ...typography.caption, color: palette.muted },
  error: { ...typography.caption, color: palette.warning },
});
