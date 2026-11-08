import type { SQLiteDatabase } from 'expo-sqlite';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ChoreBook } from '../../../components/chore-book';
import { ChoreAudiencePicker } from '../../../components/chore-audience-picker';
import { AppButton, BackButton, palette, typography } from '../../../components/planner-ui';
import type { PlannerSnapshot } from '../../../platform/storage/repository';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { unifiedGuideCatalog } from '../../chores/guide-catalog';
import { choreInAudience } from '../../chores/audience-selection';
import type { ChoreDefinition } from '../../../domain/chores/types';
import { ChoreGuide } from '../../chores/chore-guide';
import { ChorePlanToggle } from '../../chores/chore-plan-toggle';
import { setChoresEnabled } from '../../../platform/storage/repository';
import type { V2MutationOutcome } from './mutation-outcome';
import { GuideChapterActions } from '../../chores/guide-chapter-actions';
import { router } from 'expo-router';
import { v2CadenceLabel } from '../v2/cadence';

export interface PersonalGuideSource { snapshot: PlannerSnapshot; database: SQLiteDatabase; refresh: () => Promise<unknown>; readError?: () => string | null }
export function v2GuideChores(model: V2GroupScreenModel, personal?: PersonalGuideSource) {
  const shared = model.plan.chores.filter(chore => !chore.archived).map(chore => ({ ...chore, householdId: model.plan.groupId }));
  return unifiedGuideCatalog(shared, personal?.snapshot.chores ?? []);
}

/** The audience is an explicit selection, never a side effect of scrolling. */
export function V2ChoreBook({ model, personal, selectedId, source = 'shared', onBack, onRound, onConfiguration, actions, perform, hasTabBar = false }: {
  actions: V2GroupController['actions']; perform: (work: () => Promise<unknown>) => Promise<V2MutationOutcome>;
  model: V2GroupScreenModel; personal?: PersonalGuideSource; selectedId?: string; source?: 'shared' | 'personal';
  onBack: () => void; onRound?: (occurrenceId: string, subjectId: string, anchorDate?: string) => void;
  onConfiguration: (choreId: string) => void; groupName: string; hasTabBar?: boolean;
}) {
  const [selection, setSelection] = useState({ source, id: selectedId });
  const shared = useMemo(() => model.plan.chores.filter(chore => !chore.archived).map(chore => ({ ...chore, householdId: model.plan.groupId })), [model.plan.chores, model.plan.groupId]);
  const individuals = personal?.snapshot.chores ?? [];
  const isPersonal = selection.source === 'personal'; const chores = isPersonal ? individuals : shared;
  const picker = (visible?: ChoreDefinition) => <ChoreAudiencePicker value={selection.source} purpose="guide" onChange={audience => {
    setSelection({ source: audience, id: choreInAudience(audience === 'personal' ? individuals : shared, visible) });
  }} />;
  if (isPersonal && !personal) return <View style={{ flex: 1, backgroundColor: palette.background }}><View style={{ paddingHorizontal: 18 }}><BackButton onPress={onBack} />{picker()}</View><Text style={styles.unavailable}>個人家事を読み込んでいます。</Text></View>;
  return <ChoreBook key={selection.source} title="家事の説明" chores={chores} selectedId={selection.id} onBack={onBack} hasTabBar={hasTabBar}
    titleAccessory={picker}
    renderChore={chore => {
      const id = chore.id;
      const configuration = model.configurations.find(row => row.choreId === id)?.configuration;
      const display = { ...chore, ...(isPersonal || !configuration ? {} : { userIntervalDays: configuration.intervalDays, requiresCycleSelection: false }) };
      const round = model.plan.occurrences.find(row => row.choreId === id && row.subjects.some(subject => subject.subjectUserId === null || subject.subjectUserId === model.viewerUserId));
      const subject = round?.subjects.find(row => row.subjectUserId === null || row.subjectUserId === model.viewerUserId);
      return <View style={{ gap: 12 }}><ChoreGuide chore={display} mode={isPersonal ? personal!.snapshot.settings.frequencyMode : 'balanced'} cadenceLabel={isPersonal ? personal!.snapshot.personalCadences?.[id]?.label : configuration?.monthly ? v2CadenceLabel(configuration) : undefined} procedureAction={<ChorePlanToggle name={chore.name} enabled={chore.enabled}
          readOnly={!isPersonal && model.viewerUserId !== model.adminUserId} requiresCycleSelection={isPersonal ? chore.requiresCycleSelection : !configuration}
          onConfigure={() => { if (isPersonal) router.push({ pathname: '/chores/[id]', params: { id, source: 'personal' } }); else onConfiguration(id); }}
          retryRead={async () => { if (isPersonal) { await personal!.refresh(); return !personal!.readError?.(); } return (await perform(async () => {})).refreshed; }} save={async enabled => {
            if (isPersonal) { await setChoresEnabled(personal!.database, [id], enabled); await personal!.refresh(); return { refreshed: !personal!.readError?.() }; }
            const result = await perform(() => actions.patchChore(id, { enabled }));
            if (!result.committed) throw result.error ?? new Error('予定の設定を保存できませんでした。'); return { refreshed: result.refreshed };
          }} />} />
        {isPersonal ? <GuideChapterActions choreId={id} snapshot={personal!.snapshot} database={personal!.database} refresh={async () => { await personal!.refresh(); }} personalSource />
          : <View style={{ gap: 8 }}>{round && subject && onRound ? <AppButton title="日時・担当・実施状況" variant="secondary" onPress={() => onRound(round.id, subject.id, round.anchorDate)} /> : null}
            <AppButton title="この家事の設定" variant="quiet" onPress={() => onConfiguration(id)} /></View>}
      </View>;
    }} />;
}
const styles = StyleSheet.create({
  unavailable: { ...typography.body, color: palette.muted, padding: 18 },
});
