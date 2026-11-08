import { useEffect, useRef, useState } from 'react';
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
import type { V2ResponsibilityPreset } from './responsibility-choices';
import { V2RotationSettings } from './rotation-settings';

/** First activation requires a complete explicit kind/cadence; later field changes use the autosave editor. */
export function V2InitialConfiguration({ model, choreId, controller, onSaved, onBack, advanced, advancedNeedsReview, onAdvanced }: { model: V2GroupScreenModel; choreId: string;
  controller: V2GroupController; onSaved: () => Promise<void>; onBack?: () => void; advanced?: ReactNode; advancedNeedsReview?: boolean; onAdvanced?(): void }) {
  const retained = useRetainedV2Draft(`initial:${choreId}`, () => {
    const initial = () => ({ preset: '' as V2ResponsibilityPreset, memberIds: [] as string[], advanceOn: 'completion' as SharedChoreRotation['advanceOn'], anchor: model.plan.range.asOfDate as string, monthly: false, interval: '', before: '0', after: '0' });
    let draft = initial(); let dirty = false;
    return { read: () => draft, change: (value: typeof draft) => { draft = value; dirty = true; }, reset: (value: typeof draft) => { draft = value; dirty = false; }, accepted: () => { dirty = false; },
      navigateAfterSave: async (navigate: () => void) => { if (dirty) { draft = initial(); dirty = false; } navigate(); return true; }, resumeNavigation() {},
      flush: async () => !dirty, getSnapshot: () => ({ hasDraft: dirty, status: { phase: 'idle' } }) };
  });
  const [draft, setDraft] = useState(retained.read);
  const input = useRef(draft); const pending = useRef(false); const alive = useRef(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const colors = plannerColorsForScheme(useColorScheme());
  const rowStyle = [styles.row, { borderBottomColor: colors.border }];
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const edit = (patch: Partial<typeof draft>) => { if (pending.current) return; input.current = { ...input.current, ...patch }; retained.change(input.current); setDraft(input.current); setError(null); };
  const discard = () => {
    if (pending.current) return;
    const value = { preset: '' as typeof draft.preset, memberIds: [] as string[], advanceOn: 'completion' as SharedChoreRotation['advanceOn'], anchor: model.plan.range.asOfDate as string, monthly: false, interval: '', before: '0', after: '0' };
    retained.reset(value); input.current = value; setDraft(value); setError(null);
  };
  const members = model.plan.members.filter((member) => member.active);
  const enable = async () => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(null);
    try {
      const value = input.current;
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
      onMember={(userId, checked) => edit({ memberIds: checked ? [...input.current.memberIds.filter(id => id !== userId), userId] : input.current.memberIds.filter(id => id !== userId) })} />
    <V2ChoreCadence today={model.plan.range.asOfDate} anchor={draft.anchor as LocalDate} interval={draft.interval} monthly={draft.monthly}
      accessibilityLabel="初回の周期" disabled={busy} onInterval={interval => edit({ interval })} onMonthly={monthly => edit({ monthly })} onAnchor={anchor => edit({ anchor })} />
    <View style={rowStyle}><Text style={styles.label}>実施期間の幅</Text><View style={styles.window}>
      {(['before', 'after'] as const).map((field, index) => <NumberInputField key={field} borderless inputWidth={24} prefix={index === 0 ? '前' : '後'}
        accessibilityLabel={`初回の基準日より${index === 0 ? '前' : '後'}`} value={draft[field]} editable={!busy} onChangeText={text => edit({ [field]: text })} />)}
    </View></View>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <V2ConfigurationDates today={model.plan.range.asOfDate} anchor={draft.anchor} monthly={draft.monthly} disabled={busy} onAnchor={anchor => edit({ anchor })} />
    {onAdvanced || advanced || draft.preset === 'rotation' ? <V2AdvancedSettings choreId={choreId} needsReview={advancedNeedsReview} onOpen={onAdvanced}>
      {draft.preset === 'rotation' ? <V2RotationSettings members={members} disabled={busy} value={{ sequence: draft.memberIds, advanceOn: draft.advanceOn }} onChange={update => {
        if (input.current.preset !== 'rotation') return;
        const value = update({ sequence: input.current.memberIds, advanceOn: input.current.advanceOn }); edit({ memberIds: value.sequence, advanceOn: value.advanceOn });
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
