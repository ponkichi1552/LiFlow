import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';
import { BackButton, palette, typography } from '../../../components/planner-ui';
import { SettingsPanel } from '../../../components/settings-controls';
import { SettingsCheckbox } from '../../../components/settings-checkbox';
import { plannerColorsForScheme } from '../../../components/planner-theme';
import { NumberInputField } from '../../../components/number-input-field';
import { parseLocalDate } from '../../../domain/scheduling/local-date';
import type { LocalDate } from '../../../domain/shared/types';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { chorePolicyFromPreset } from '../v2/model';
import { useRetainedV2Draft } from './settings-draft-cache';
import { V2ResponsibilityChoices } from './responsibility-choices';
import { V2AdvancedSettings } from './advanced-settings';
import { V2ConfigurationDates } from './configuration-dates';
import { V2ChoreCadence } from './chore-cadence';
import { ScheduleResetAction } from '../../../components/schedule-reset-action';
import type { SharedChoreRotation } from '../v2/model';
import { V2RotationSettings } from './rotation-settings';
import { initialConfigurationDraft } from './initial-configuration-draft';

/** First activation requires a complete explicit kind/cadence; later field changes use the autosave editor. */
export function V2InitialConfiguration({ model, choreId, controller, onSaved, onBack, advanced, advancedNeedsReview, onAdvanced, advancedOnly = false }: { model: V2GroupScreenModel; choreId: string;
  controller: V2GroupController; onSaved: () => Promise<void>; onBack?: () => void; advanced?: ReactNode; advancedNeedsReview?: boolean; onAdvanced?(): void; advancedOnly?: boolean }) {
  // Screen sessions wrap the controller, but its authenticated actions retain a stable identity.
  const retained = useRetainedV2Draft(`initial:${choreId}`, () => initialConfigurationDraft(controller.actions, `${model.plan.groupId}:${model.viewerUserId}:${choreId}`, model.plan.range.asOfDate));
  const draft = useSyncExternalStore(retained.subscribe, retained.read, retained.read);
  const pending = useRef(false); const alive = useRef(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const colors = plannerColorsForScheme(useColorScheme());
  const rowStyle = [styles.row, { borderBottomColor: colors.border }];
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useFocusEffect(useCallback(() => { if (!advancedOnly) retained.resumeBasic(); }, [retained, advancedOnly]));
  const edit = (patch: Partial<typeof draft>) => { if (pending.current) return; retained.change({ ...retained.read(), ...patch }); setError(null); };
  const discard = () => {
    if (pending.current) return;
    const value = { preset: '' as typeof draft.preset, memberIds: [] as string[], advanceOn: 'completion' as SharedChoreRotation['advanceOn'], anchor: model.plan.range.asOfDate as string, monthly: false, interval: '', before: '0', after: '0' };
    retained.reset(value); setError(null);
  };
  if (advancedOnly) return <View style={styles.group}><Text style={styles.label}>日付</Text><SettingsPanel>
    <V2ConfigurationDates unfolded today={model.plan.range.asOfDate} anchor={draft.anchor} monthly={draft.monthly} disabled={busy} onAnchor={anchor => edit({ anchor })} />
    <V2ChoreCadence today={model.plan.range.asOfDate} anchor={draft.anchor as LocalDate} interval={draft.interval} monthly={draft.monthly}
      accessibilityLabel="初回の周期" disabled={busy} onInterval={interval => edit({ interval })} onMonthly={monthly => edit({ monthly })} onAnchor={anchor => edit({ anchor })} />
  </SettingsPanel></View>;
  const members = model.plan.members.filter((member) => member.active);
  const enable = async () => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(null);
    try {
      const value = retained.read();
      if (!value.preset) throw new Error('担当を選んでください。');
      const number = (text: string, min: number, max: number, label: string) => {
        if (!/^\d+$/u.test(text)) throw new Error(`${label}を整数で入力してください。`);
        const parsed = Number(text); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label}は${min}〜${max}日で入力してください。`); return parsed;
      };
      try { parseLocalDate(value.anchor as LocalDate); } catch { throw new Error('繰り返しの開始日を選んでください。'); }
      await controller.actions.configureChore(choreId, { policy: chorePolicyFromPreset(value.preset, value.memberIds, value.advanceOn), anchorDate: value.anchor as LocalDate,
        intervalDays: value.monthly ? 30 : number(value.interval, 1, 3650, '周期'), ...(value.monthly ? { monthly: true } : {}), windowBeforeDays: number(value.before, 0, 14, '基準日より前'), windowAfterDays: number(value.after, 0, 14, '基準日より後'),
        effectiveFrom: value.anchor > model.plan.range.asOfDate ? value.anchor as LocalDate : model.plan.range.asOfDate, active: true,
        ...(value.preset === 'eachMember' ? { targetMemberIds: members.map((member) => member.userId) } : {}) }, { expectedRuleVersion: 0 });
      retained.accepted(); await onSaved();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '設定を保存できませんでした。'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <View style={styles.group}>{onBack ? <BackButton onPress={onBack} disabled={busy} /> : null}
    <SettingsPanel>
    <View style={rowStyle}><Text style={styles.label}>予定に追加</Text><SettingsCheckbox accessibilityLabel="この条件で家事を有効にする" value={busy}
      disabled={busy} onValueChange={checked => { if (checked) void enable(); }} /></View>
    <V2ResponsibilityChoices members={members} preset={draft.preset} memberIds={draft.memberIds} disabled={busy}
      onPreset={preset => edit({ preset, ...(preset === 'rotation' ? { memberIds: members.map(member => member.userId), advanceOn: 'completion' } : {}) })}
      onMember={(userId, checked) => edit({ memberIds: checked ? [...retained.read().memberIds.filter(id => id !== userId), userId] : retained.read().memberIds.filter(id => id !== userId) })} />
    <V2ChoreCadence today={model.plan.range.asOfDate} anchor={draft.anchor as LocalDate} interval={draft.interval} monthly={draft.monthly}
      modeSelection={false} accessibilityLabel="初回の周期" disabled={busy} onInterval={interval => edit({ interval })} onMonthly={monthly => edit({ monthly })} onAnchor={anchor => edit({ anchor })} />
    <View style={rowStyle}><Text style={styles.label}>実施期間の幅</Text><View style={styles.window}>
      {(['before', 'after'] as const).map((field, index) => <NumberInputField key={field} borderless inputWidth={24} prefix={index === 0 ? '前' : '後'}
        accessibilityLabel={`初回の基準日より${index === 0 ? '前' : '後'}`} value={draft[field]} editable={!busy} onChangeText={text => edit({ [field]: text })} />)}
    </View></View>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {onAdvanced || advanced || draft.preset === 'rotation' ? <V2AdvancedSettings choreId={choreId} needsReview={advancedNeedsReview} onOpen={onAdvanced ? () => { retained.openDetails(); onAdvanced(); } : undefined}>
      {draft.preset === 'rotation' ? <V2RotationSettings members={members} disabled={busy} value={{ sequence: draft.memberIds, advanceOn: draft.advanceOn }} onChange={update => {
        const current = retained.read(); if (current.preset !== 'rotation') return;
        const value = update({ sequence: current.memberIds, advanceOn: current.advanceOn }); edit({ memberIds: value.sequence, advanceOn: value.advanceOn });
      }} /> : null}
      {advanced}</V2AdvancedSettings> : null}
    <ScheduleResetAction accessibilityLabel="入力を戻す" disabled={busy || !retained.getSnapshot().hasDraft} onReset={async () => discard()} />
    </SettingsPanel>
  </View>;
}
const styles = StyleSheet.create({
  group: { gap: 8 }, window: { flexDirection: 'row', gap: 6 },
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 8, borderBottomWidth: 1 },
  label: { ...typography.body, color: palette.ink, flexShrink: 1 }, error: { ...typography.caption, color: palette.warning },
});
