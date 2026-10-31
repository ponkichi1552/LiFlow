import type { SQLiteDatabase } from 'expo-sqlite';
import { View } from 'react-native';
import { ChoreBook } from '../../../components/chore-book';
import { SettingsAudience } from '../../../components/settings-audience';
import { AppButton } from '../../../components/planner-ui';
import type { PlannerSnapshot } from '../../../platform/storage/repository';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { guideCatalogSelection, unifiedGuideCatalog } from '../../chores/guide-catalog';
import { ChoreGuide } from '../../chores/chore-guide';
import { ChorePlanToggle } from '../../chores/chore-plan-toggle';
import { setChoresEnabled } from '../../../platform/storage/repository';
import type { V2MutationOutcome } from './mutation-outcome';
import { GuideChapterActions } from '../../chores/guide-chapter-actions';

export interface PersonalGuideSource { snapshot: PlannerSnapshot; database: SQLiteDatabase; refresh: () => Promise<unknown>; readError?: () => string | null }
export function v2GuideChores(model: V2GroupScreenModel, personal?: PersonalGuideSource) {
  const shared = model.plan.chores.filter(chore => !chore.archived).map(chore => ({ ...chore, householdId: model.plan.groupId }));
  return unifiedGuideCatalog(shared, personal?.snapshot.chores ?? []);
}

/** One document and one renderer; source IDs are namespaced only for presentation. */
export function V2ChoreBook({ model, personal, selectedId, source = 'shared', onBack, onRound, onConfiguration, groupName, actions, perform }: {
  actions: V2GroupController['actions']; perform: (work: () => Promise<unknown>) => Promise<V2MutationOutcome>;
  model: V2GroupScreenModel; personal?: PersonalGuideSource; selectedId?: string; source?: 'shared' | 'personal';
  onBack: () => void; onRound?: (occurrenceId: string, subjectId: string, anchorDate?: string) => void;
  onConfiguration: (choreId: string) => void; groupName: string;
}) {
  const chores = v2GuideChores(model, personal);
  const original = (source === 'personal' ? personal?.snapshot.chores : model.plan.chores)?.find(chore => chore.id === selectedId);
  const selected = guideCatalogSelection(chores, source, original);
  return <ChoreBook title="家事の説明" chores={chores} selectedId={selected} onBack={onBack}
    titleAccessory={chore => <SettingsAudience groupName={chore?.id.startsWith('personal:') ? undefined : groupName} />}
    renderChore={chore => {
      const isPersonal = chore.id.startsWith('personal:'); const id = chore.id.slice(chore.id.indexOf(':') + 1);
      const original = isPersonal ? personal?.snapshot.chores.find(row => row.id === id) : model.plan.chores.find(row => row.id === id);
      if (!original) return null;
      const configuration = model.configurations.find(row => row.choreId === id)?.configuration;
      const display = { ...chore, ...(isPersonal || !configuration ? {} : { userIntervalDays: configuration.intervalDays, requiresCycleSelection: false }) };
      const round = model.plan.occurrences.find(row => row.choreId === id && row.subjects.some(subject => subject.subjectUserId === null || subject.subjectUserId === model.viewerUserId));
      const subject = round?.subjects.find(row => row.subjectUserId === null || row.subjectUserId === model.viewerUserId);
      return <View style={{ gap: 12 }}><ChoreGuide chore={display} mode={isPersonal ? personal!.snapshot.settings.frequencyMode : 'balanced'} procedureAction={<ChorePlanToggle name={chore.name} enabled={chore.enabled}
          readOnly={!isPersonal && model.viewerUserId !== model.adminUserId} retryRead={async () => { if (isPersonal) { await personal!.refresh(); return !personal!.readError?.(); } return (await perform(async () => {})).refreshed; }} save={async enabled => {
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
