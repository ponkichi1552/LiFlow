import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, BackButton, Card, SectionHeading } from '../../../components/planner-ui';
import { NumberInputField } from '../../../components/number-input-field';
import { parseLocalDate } from '../../../domain/scheduling/local-date';
import type { LocalDate } from '../../../domain/shared/types';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { chorePolicyFromPreset } from '../v2/model';
import { v2MemberLabels } from './member-labels';
import { V2Choices, V2Flag, V2TextField, v2FormStyles as styles } from './form-controls';
import { useRetainedV2Draft } from './settings-draft-cache';

/** First activation requires a complete explicit kind/cadence; later field changes use the autosave editor. */
export function V2InitialConfiguration({ model, choreId, controller, onSaved, onBack }: { model: V2GroupScreenModel; choreId: string;
  controller: V2GroupController; onSaved: () => Promise<void>; onBack?: () => void }) {
  const retained = useRetainedV2Draft(`initial:${choreId}`, () => {
    let draft = { preset: '' as '' | 'common' | 'eachMember' | 'assigned', memberIds: [] as string[], anchor: model.plan.range.asOfDate as string, interval: '', before: '0', after: '0' }; let dirty = false;
    return { read: () => draft, change: (value: typeof draft) => { draft = value; dirty = true; }, reset: (value: typeof draft) => { draft = value; dirty = false; }, accepted: () => { dirty = false; },
      flush: async () => !dirty, getSnapshot: () => ({ hasDraft: dirty, status: { phase: 'idle' } }) };
  });
  const [draft, setDraft] = useState(retained.read);
  const input = useRef(draft); const pending = useRef(false); const alive = useRef(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const edit = (patch: Partial<typeof draft>) => { if (pending.current) return; input.current = { ...input.current, ...patch }; retained.change(input.current); setDraft(input.current); setError(null); };
  const discard = () => {
    if (pending.current) return;
    const value = { preset: '' as typeof draft.preset, memberIds: [] as string[], anchor: model.plan.range.asOfDate as string, interval: '', before: '0', after: '0' };
    retained.reset(value); input.current = value; setDraft(value); setError(null);
  };
  const members = model.plan.members.filter((member) => member.active); const nameOf = v2MemberLabels(members);
  const enable = async () => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(null);
    try {
      const value = input.current;
      if (!value.preset) throw new Error('家事の種類を選んでください。');
      const number = (text: string, min: number, max: number, label: string) => {
        if (!/^\d+$/u.test(text)) throw new Error(`${label}を整数で入力してください。`);
        const parsed = Number(text); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label}は${min}〜${max}日で入力してください。`); return parsed;
      };
      try { parseLocalDate(value.anchor as LocalDate); } catch { throw new Error('基準日をYYYY-MM-DD形式の有効な日付で入力してください。'); }
      await controller.actions.configureChore(choreId, { policy: chorePolicyFromPreset(value.preset, value.memberIds), anchorDate: value.anchor as LocalDate,
        intervalDays: number(value.interval, 1, 3650, '周期'), windowBeforeDays: number(value.before, 0, 14, '基準日より前'), windowAfterDays: number(value.after, 0, 14, '基準日より後'),
        effectiveFrom: value.anchor > model.plan.range.asOfDate ? value.anchor as LocalDate : model.plan.range.asOfDate, active: true,
        ...(value.preset === 'eachMember' ? { targetMemberIds: members.map((member) => member.userId) } : {}) }, { expectedRuleVersion: 0 });
      retained.accepted(); await onSaved();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '設定を保存できませんでした。'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <View style={styles.group}>{onBack ? <BackButton onPress={onBack} disabled={busy} /> : null}<Card>
    <SectionHeading title="家事の種類と周期を設定" />
    <Text style={styles.caption}>まだ有効になっていません。条件を確認してから予定へ追加します。</Text>
    <V2Choices label="家事の種類" value={draft.preset} disabled={busy} onChange={(preset) => edit({ preset })}
      choices={[{ value: 'common', label: '誰か1人が行う' }, { value: 'eachMember', label: 'メンバーごとに行う' }, { value: 'assigned', label: '担当者を決める' }]} />
    {draft.preset === 'assigned' ? members.map((member) => <V2Flag key={member.userId} label={`担当：${nameOf(member.userId)}`}
      value={draft.memberIds.includes(member.userId)} disabled={busy} onChange={(checked) => edit({ memberIds: checked ? [...input.current.memberIds, member.userId] : input.current.memberIds.filter((id) => id !== member.userId) })} />) : null}
    <V2TextField label="共有家事の基準日" value={draft.anchor} editable={!busy} onChangeText={(anchor) => edit({ anchor })} />
    {([['interval', '周期'], ['before', '基準日より前'], ['after', '基準日より後']] as const).map(([field, label]) => <View key={field} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><Text style={[styles.label, { flexShrink: 1 }]}>{label}</Text>
      <NumberInputField accessibilityLabel={`初回の${label}`} value={draft[field]} editable={!busy} onChangeText={(text) => edit({ [field]: text })} /></View>)}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <AppButton title="この条件で家事を有効にする" disabled={busy} onPress={() => void enable()} />
    {retained.getSnapshot().hasDraft ? <AppButton title="入力を戻す" variant="quiet" disabled={busy} onPress={discard} /> : null}
  </Card></View>;
}
