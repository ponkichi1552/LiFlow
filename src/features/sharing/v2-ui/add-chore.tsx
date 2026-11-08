import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { AppButton, SectionHeading } from '../../../components/planner-ui';
import { SettingsPanel } from '../../../components/settings-controls';
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

export function V2AddChore({ model, actions, busy, run, onCreated, onBack, header }: { model?: V2GroupScreenModel; actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>; onCreated: (id: string) => void; onBack: () => void; header?: ReactNode }) {
  const administrator = Boolean(model && model.viewerUserId === model.adminUserId);
  const members = model?.plan.members.filter(member => member.active) ?? [];
  const [draft, setDraft] = useState({ name: '', interval: '', monthly: false, preset: '' as V2ResponsibilityPreset, memberIds: [] as string[], advanceOn: 'completion' as SharedChoreRotation['advanceOn'], startDate: model?.plan.range.asOfDate ?? '', ...initialCustomChoreOptions });
  const input = useRef(draft); const pending = useRef(false); const alive = useRef(true);
  const durable = useRef<string | null>(null); const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const edit = (patch: Partial<typeof draft>) => { if (pending.current || busy || durable.current) return; input.current = { ...input.current, ...patch }; setDraft(input.current); setError(null); };
  const create = async () => {
    if (pending.current || busy) return; pending.current = true; setError(null);
    try {
      if (durable.current) { if (alive.current) onCreated(durable.current); return; }
      const value = input.current;
      const name = v2ChoreDetailCodecs.name.parse(value.name) as string;
      const configured = administrator ? customChoreInput(name, value.monthly ? 30 : value.interval) : null;
      if (configured && !value.preset) throw new Error('担当を選んでください。');
      const policy = configured && value.preset ? chorePolicyFromPreset(value.preset, value.memberIds, value.advanceOn) : null;
      const steps = v2ChoreDetailCodecs.instructions.parse(value.steps) as string[]; let created: string | undefined;
      await run(async () => {
        const operations = configured && policy ? await actions.addConfiguredChore(configured.name, configured.intervalDays, policy, { ...parsedCustomChoreOptions(value), startDate: value.startDate as LocalDate, ...(value.monthly ? { monthly: true } : {}) }) : await actions.addChore(name, steps);
        created = operations[0]?.entityId;
        if (created) { durable.current = created; if (alive.current) setCreatedId(created); }
      });
      if (created && alive.current) onCreated(created);
    } catch (cause) { if (alive.current) setError(durable.current ? '端末に追加済みです。もう一度開いてください。'
      : cause instanceof Error ? cause.message : '追加する内容を確認してください。'); }
    finally { pending.current = false; }
  };
  return <V2FormScrollView contentContainerStyle={{ padding: 18, gap: 12, paddingBottom: 16 }} header={<ChoreAddHeader disabled={busy} onBack={() => { if (!pending.current) onBack(); }} />}
    footer={<>{error ? <Text accessibilityRole="alert" style={[styles.error, { paddingBottom: 8 }]}>{error}</Text> : null}
      <AppButton title={createdId ? '追加済みの家事を開く' : '追加'} accessibilityLabel={createdId ? undefined : administrator ? '追加' : 'この内容を共有家事に追加'} disabled={busy} onPress={() => void create()} /></>}>{header}
    <Text style={styles.caption}>グループ全員に公開します。</Text>
    {!administrator ? <Text style={styles.caption}>周期・担当の設定は管理者が行います。</Text> : null}
      {administrator ? <>
        <SectionHeading title="必須" level="subsection" /><SettingsPanel>
        <CustomChoreFields name={draft.name} interval={draft.interval} onName={name => edit({ name })} onInterval={interval => edit({ interval })} disabled={busy || Boolean(createdId)}
          cadenceField={<V2ChoreCadence today={model?.plan.range.asOfDate ?? draft.startDate as LocalDate} anchor={draft.startDate as LocalDate}
            interval={draft.interval} monthly={draft.monthly} accessibilityLabel="追加する家事の周期" disabled={busy || Boolean(createdId)}
            onInterval={interval => edit({ interval })} onMonthly={monthly => edit({ monthly })} onAnchor={startDate => edit({ startDate })} />} />
        <V2ResponsibilityChoices members={members} preset={draft.preset} memberIds={draft.memberIds} disabled={busy || Boolean(createdId)}
          onPreset={preset => edit({ preset, ...(preset === 'rotation' ? { memberIds: members.map(member => member.userId), advanceOn: 'completion' } : {}) })}
          onMember={(userId, checked) => edit({ memberIds: checked ? [...input.current.memberIds.filter(id => id !== userId), userId] : input.current.memberIds.filter(id => id !== userId) })} />
        </SettingsPanel><SectionHeading title="任意" level="subsection" /><SettingsPanel>
        <CustomChoreOptionsFields shared value={draft} onChange={edit} disabled={busy || Boolean(createdId)} />
        {model ? <V2ConfigurationDates today={model.plan.range.asOfDate} anchor={draft.startDate} monthly={draft.monthly} onAnchor={startDate => edit({ startDate })} disabled={busy || Boolean(createdId)} /> : null}
        {draft.preset === 'rotation' ? <V2RotationSettings members={members} value={{ sequence: draft.memberIds, advanceOn: draft.advanceOn }} disabled={busy || Boolean(createdId)}
          onChange={update => { if (input.current.preset !== 'rotation') return;
            const value = update({ sequence: input.current.memberIds, advanceOn: input.current.advanceOn }); edit({ memberIds: value.sequence, advanceOn: value.advanceOn }); }} /> : null}
        <CustomChoreStepsField value={draft.steps} onChange={steps=>edit({steps})} disabled={busy || Boolean(createdId)} />
        </SettingsPanel>
      </> : <><SectionHeading title="必須" level="subsection" /><SettingsPanel>
        <V2TextField label="追加する共有家事の名前" value={draft.name} maxLength={500} editable={!busy && !createdId} onChangeText={name => edit({ name })} />
      </SettingsPanel><SectionHeading title="任意" level="subsection" /><SettingsPanel>
        <V2TextField label="追加する手順（1行に1手順）" value={draft.steps} multiline editable={!busy && !createdId} onChangeText={steps => edit({ steps })} />
      </SettingsPanel></>}
  </V2FormScrollView>;
}
