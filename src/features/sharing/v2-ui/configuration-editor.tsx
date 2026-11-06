import { SettingsSwitch as Switch } from '@/components/settings-switch';
import { FormTextInput as TextInput } from '../../../components/form-text-input';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BackButton, Card, palette, SectionHeading, typography } from '../../../components/planner-ui';
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

/** Only an authenticated administrator receives the editor; receiver authority remains the final check. */
export function V2ConfigurationEditor(props: { model: V2GroupScreenModel; choreId: string;
  controller: V2GroupController; onSaved: () => Promise<void>; onBack?: () => void }) {
  const { model, choreId } = props;
  if (model.viewerUserId !== model.adminUserId) return <View style={styles.container}>{props.onBack ? <BackButton onPress={props.onBack} /> : null}
    <Text style={styles.caption}>周期と有効状態は管理者が変更します。</Text></View>;
  return <RetainedEditor key={`${model.plan.groupId}:${choreId}`} {...props} />;
}

function RetainedEditor({ model, choreId, controller, onSaved, onBack }: Parameters<typeof V2ConfigurationEditor>[0]) {
  const row = model.configurations.find((entry) => entry.choreId === choreId);
  const [retained, setRetained] = useState(row?.configuration ?? null);
  // Retain the editor (and its draft store) when a remote conflict temporarily removes the resolved value.
  if (row?.configuration && (!retained || row.configuration.ruleVersion >= retained.ruleVersion && canonicalJson(row.configuration) !== canonicalJson(retained))) setRetained(row.configuration);
  const configuration = row?.configuration && (!retained || row.configuration.ruleVersion >= retained.ruleVersion) ? row.configuration : retained;
  const conflict = !row?.configuration && row?.candidates.length ? <V2ConfigurationConflict model={model} row={row} controller={controller}
    onSaved={onSaved} onBack={!configuration ? onBack : undefined} /> : null;
  if (!configuration) return conflict
    ?? <V2InitialConfiguration model={model} choreId={choreId} controller={controller} onSaved={onSaved} onBack={onBack} />;
  const boundary = configuration.effectiveFrom ?? configuration.anchorDate;
  const earliestFrom = row?.earliestEffectiveFrom && row.earliestEffectiveFrom > boundary ? row.earliestEffectiveFrom : boundary;
  return <View style={styles.container}>{conflict}<Editor configuration={configuration} earliestFrom={earliestFrom}
    today={model.plan.range.asOfDate} choreId={choreId} controller={controller} onSaved={onSaved} onBack={onBack} blocked={!row?.configuration} /></View>;
}

function Editor({ configuration, earliestFrom, today, choreId, controller, onSaved, onBack, blocked }: { configuration: SharedChoreConfiguration;
  earliestFrom: LocalDate; today: LocalDate; choreId: string; controller: V2GroupController; onSaved: () => Promise<void>; onBack?: () => void; blocked: boolean }) {
  const autosave = useV2ConfigurationAutosave({ configuration, effectiveFrom: today > earliestFrom ? today : earliestFrom,
    save: (edits, date) => { if (blocked) return Promise.reject(new V2StaleSettingsError()); return controller.actions.patchChoreConfigurationFields(choreId, edits, date); }, onSaved }, `configuration:${choreId}`);
  const saving = autosave.status.phase === 'pending' || autosave.status.phase === 'saving';
  const from = autosave.effectiveFrom;
  const fromError = (() => { try { parseLocalDate(from); if (from < earliestFrom) throw new Error('Boundary'); return null; }
    catch { return `適用開始日は${earliestFrom}以降の日付にしてください。`; } })();
  const date = (text: string) => autosave.changeEffectiveFrom(text as LocalDate);
  return <View style={styles.container}>
    {onBack ? <BackButton disabled={autosave.leaving} onPress={() => void autosave.navigateAfterSave(onBack)} /> : null}
    <Card>
    {blocked ? <Text accessibilityRole="alert" style={styles.error}>設定が競合しています。入力は保持しています。候補を確認して解決するか、入力を戻してください。</Text> : null}
    <SectionHeading title="共通の周期・実施期間" />
    <Text style={styles.label}>変更の適用開始日</Text>
    <TextInput accessibilityLabel="共有設定の適用開始日" value={from} onChangeText={date} editable={!blocked && !saving && !autosave.hasDraft()}
      onEndEditing={() => { if (!fromError) void autosave.flush(); }} autoCapitalize="none" style={styles.input} />
    {fromError ? <Text accessibilityRole="alert" style={styles.error}>{fromError}</Text> : null}
    <Text style={styles.caption}>保存中の変更には同じ適用開始日を使います。完了済みの履歴は保持されます。</Text>
    <View style={styles.row}><Text style={styles.label}>家事を有効にする</Text><Switch accessibilityLabel="共有家事を有効にする" value={autosave.draft.active}
      disabled={blocked || Boolean(fromError)} onValueChange={autosave.changeActive} /></View>
    <Text style={styles.label}>基準日</Text>
    <TextInput accessibilityLabel="共有家事の基準日" value={autosave.draft.anchorDate} onChangeText={autosave.changeAnchor}
      onEndEditing={() => void autosave.flush()} editable={!blocked && !fromError} autoCapitalize="none" style={styles.input} />
    {autosave.anchorError ? <Text accessibilityRole="alert" style={styles.error}>{autosave.anchorError}</Text> : null}
    {(['intervalDays', 'windowBeforeDays', 'windowAfterDays'] as const).map((field) => {
      const label = field === 'intervalDays' ? '周期' : field === 'windowBeforeDays' ? '基準日より前' : '基準日より後'; const error = autosave.numberError(field);
      return <View key={field}><View style={styles.row}><Text style={styles.label}>{label}</Text>
        <NumberInputField accessibilityLabel={`共有家事の${label}`} value={autosave.draft[field]} editable={!blocked && !fromError}
          onChangeText={(text) => autosave.changeNumber(field, text)} onEndEditing={() => void autosave.flush()} /></View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</View>;
    })}
    <V2AutosaveFeedback status={autosave.status} refreshError={autosave.refreshError} hasDraft={autosave.hasDraft()} flush={autosave.flush}
      discard={autosave.discard} discardTitle="入力を最新の設定に戻す" disabled={autosave.leaving} />
    <ScheduleResetAction disabled={blocked || Boolean(fromError) || saving || autosave.hasDraft()} onReset={async () => {
      if (!await autosave.flush()) throw new Error('入力内容を確認してください。');
      await controller.actions.resetChoreSchedules([choreId], { [choreId]: configuration.ruleVersion }, from); await onSaved();
    }} />
    </Card>
  </View>;
}
const styles = StyleSheet.create({
  container: { gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 6 },
  label: { ...typography.label, color: palette.ink, flexShrink: 1 }, caption: { ...typography.caption, color: palette.muted },
  error: { ...typography.caption, color: palette.warning }, input: { ...typography.body, color: palette.ink, borderWidth: 1, borderColor: palette.border,
    borderRadius: 11, paddingHorizontal: 12, minHeight: 46 },
});
