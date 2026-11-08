import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, BackButton } from '../../../components/planner-ui';
import { AccordionSection } from '../../../components/accordion-section';
import { parseLocalDate } from '../../../domain/scheduling/local-date';
import type { LocalDate } from '../../../domain/shared/types';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { V2TextField, v2FormStyles as styles } from './form-controls';
import { v2MemberLabels } from './member-labels';
import { v2CadenceLabel } from '../v2/cadence';

export function V2ConfigurationConflict({ model, row, controller, onSaved, onBack }: { model: V2GroupScreenModel;
  row: V2GroupScreenModel['configurations'][number]; controller: V2GroupController; onSaved: () => Promise<void>; onBack?: () => void }) {
  const minimum = [model.plan.range.asOfDate, row.earliestEffectiveFrom, ...row.candidates.map(candidate => candidate.configuration.anchorDate)].sort().at(-1)!;
  const [from, setFrom] = useState<string>(minimum); const input = useRef(from); const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const pending = useRef(false); const alive = useRef(true); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null); const nameOf = v2MemberLabels(model.plan.members);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const choose = async (candidate: typeof row.candidates[number]) => {
    if (pending.current || saved) return; pending.current = true; setBusy(true); setError(null);
    let committed = false;
    try {
      const date = input.current as LocalDate;
      try { parseLocalDate(date); } catch { throw new Error('適用開始日をYYYY-MM-DD形式の有効な日付で入力してください。'); }
      if (date < minimum) throw new Error(`適用開始日は${minimum}以降の日付にしてください。`);
      await controller.actions.configureChore(row.choreId, { ...candidate.configuration, effectiveFrom: date }, {
        expectedRuleVersion: row.revision, resolveConfigurationIds: row.candidates.map(source => source.operationId), preserveAssignments: false,
      });
      committed = true; if (alive.current) setSaved(true); await onSaved();
    } catch (cause) { if (alive.current) setError(committed ? '端末に保存済みです。表示を再読込してください。'
      : cause instanceof Error ? cause.message : '候補を保存できませんでした。'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <View style={styles.group}>{onBack ? <BackButton disabled={busy} onPress={() => { if (!pending.current) onBack(); }} /> : null}
    <Text accessibilityRole="alert" style={styles.error}>共通設定が競合しています。候補を開いて確認してください。</Text>
    {saved ? <AppButton title="保存済みの設定を再読込" variant="secondary" disabled={busy} onPress={() => void onSaved().catch(() => setError('端末に保存済みです。画面を開き直してください。'))} /> : <>
      {row.candidates.some(candidate => expanded[candidate.operationId]) ? <V2TextField label="競合解決の適用開始日" value={from} editable={!busy}
        onChangeText={(value) => { if (!pending.current) { input.current = value; setFrom(value); setError(null); } }} /> : null}
      {row.candidates.map((candidate, index) => {
        const cfg = candidate.configuration; const policy = cfg.policy;
        return <AccordionSection key={candidate.operationId} title={`設定候補${index + 1}`} expanded={expanded[candidate.operationId] === true}
          onToggle={() => setExpanded(value => ({ ...value, [candidate.operationId]: !value[candidate.operationId] }))}>
          <Text style={styles.caption}>変更者：{nameOf(candidate.authorUserId)}</Text>
          <Text style={styles.body}>{policy.completion === 'perMember' ? '対象者ごとに実施' : policy.assignment.mode === 'open' ? '誰か1人が実施' : '指定した担当者が実施'}</Text>
          {policy.assignment.mode === 'selected' ? <Text style={styles.caption}>担当：{policy.assignment.memberIds.map(nameOf).join('・')}</Text>
            : policy.completion === 'perMember' ? <Text style={styles.caption}>対象：{(cfg.targetMemberIds ?? model.plan.members.filter(member => member.active).map(member => member.userId)).map(nameOf).join('・')}</Text> : null}
          <Text style={styles.body}>{cfg.active === false ? '無効' : '有効'} · 開始日 {cfg.anchorDate} · {v2CadenceLabel(cfg)}</Text>
          <Text style={styles.caption}>実施期間：基準日の{cfg.windowBeforeDays}日前〜{cfg.windowAfterDays}日後</Text>
          <Text style={styles.caption}>完了履歴は保持します。既存の回への担当指定は自動で付け替えません。解決後に担当を確認してください。</Text>
          <AppButton title={`設定候補${index + 1}で解決する`} variant="secondary" disabled={busy} onPress={() => void choose(candidate)} />
        </AccordionSection>;
      })}
    </>}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}
