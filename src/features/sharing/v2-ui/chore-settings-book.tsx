import { router, useFocusEffect, usePreventRemove } from 'expo-router';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { ChoreBook } from '../../../components/chore-book';
import { palette, typography } from '../../../components/planner-ui';
import { SettingsAudience } from '../../../components/settings-audience';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2GroupUiSession } from './screen-session';
import { V2SettingsDraftCache, type RetainedV2Draft } from './settings-draft-cache';
import { V2ConfigurationEditor } from './configuration-editor';
import { choreInAudience, type ChoreAudienceSelection } from '../../chores/audience-selection';

/** The same continuous document as personal settings, with shared authority enforced by each editor. */
export function V2ChoreSettingsBook({ model, session, choreId, selection, groupName, onBack, onSaved, development = false }: {
  model: V2GroupScreenModel; session: V2GroupUiSession; choreId?: string; groupName: string; onBack(): void; onSaved(): Promise<void>;
  development?: boolean; selection?: ChoreAudienceSelection;
}) {
  const drafts = useMemo(() => new Map<string, RetainedV2Draft>(), []); const leaving = useRef(false);
  const allowRemoval = useRef(() => {});
  const [error, setError] = useState<string | null>(null);
  const leave = async (navigate: () => void, canNavigate = () => true) => {
    if (leaving.current) return; leaving.current = true; let departed = false; setError(null);
    try {
      for (const draft of drafts.values()) void draft.navigateAfterSave(() => {});
      if (!canNavigate()) { setError('所属グループが変わりました。設定画面を開き直してください。'); return; }
      allowRemoval.current(); navigate(); departed = true;
    } catch { setError('画面を移動できませんでした。もう一度お試しください。');
    } finally { if (!departed) leaving.current = false; }
  };
  const disablePrevention = usePreventRemove(true, ({ repeat }) => { void leave(repeat); });
  useLayoutEffect(() => { allowRemoval.current = disablePrevention; }, [disablePrevention]);
  useFocusEffect(useCallback(() => {
    leaving.current = false;
    for (const draft of drafts.values()) draft.resumeNavigation();
    return () => { for (const draft of drafts.values()) void draft.navigateAfterSave(() => {}); };
  }, [drafts]));
  const chores = model.plan.chores.filter(row => !row.archived).map(row => ({ ...row, householdId: model.plan.groupId }));
  const selectedId = selection ? choreInAudience(chores, selection) : choreId;
  return <V2SettingsDraftCache.Provider value={drafts}><ChoreBook title="家事ごとの設定" chores={chores} collapseSplits
    beforeCollapse={async chore => {
      for (const [key, draft] of drafts) if (key.endsWith(`:${chore.id}`)) void draft.navigateAfterSave(() => {});
      setError(null); return true;
    }}
    banner={development ? <Text style={[typography.caption, { color: palette.warning }]}>開発用・端末内プレビュー</Text> : undefined}
    selectedId={selectedId} titleAccessory={visible => <SettingsAudience groupName={groupName} chore={visible} navigate={leave} />} onBack={() => void leave(onBack)}
    header={error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : undefined}
    renderChore={(chore, presentation) => <SettingsChapter key={chore.id} choreId={chore.id} model={model} controller={session.controller} onSaved={onSaved} hideHeading={presentation?.hideHeading}
      onAdvanced={() => void leave(() => router.push({ pathname: development ? '/development/sharing-v2-preview/chore-options' : '/group-v2/chore-options', params: { choreId: chore.id } }))} />} />
  </V2SettingsDraftCache.Provider>;
}

function SettingsChapter({ choreId, model: source, controller, onSaved, hideHeading = false, onAdvanced }: { choreId: string; model: V2GroupScreenModel;
  controller: V2GroupController; onSaved(): Promise<void>; hideHeading?: boolean; onAdvanced(): void;
}) {
  // Every chapter uses the same authenticated read point; scrolling performs no new database reads.
  const model = { ...source, dateRights: source.choreDateRights?.find(row => row.choreId === choreId) };
  const chore = model.plan.chores.find(row => row.id === choreId);
  const fields = model.choreDetails.find(row => row.choreId === choreId)?.fields;
  const needsReview = Boolean(fields && Object.values(fields).some(field => field.kind === 'conflict')
    || model.dateRights && Object.values(model.dateRights.fields).some(field => field.kind === 'conflict'));
  return <View style={{ gap: 8 }}>{!hideHeading ? <Text accessibilityRole="header" style={{ ...typography.section, color: palette.ink, fontWeight: '700', marginBottom: 2 }}>{chore?.name ?? '共有家事'}</Text> : null}
      <V2ConfigurationEditor model={model} choreId={choreId} controller={controller} onSaved={onSaved} advancedNeedsReview={needsReview} onAdvanced={onAdvanced} />
  </View>;
}
