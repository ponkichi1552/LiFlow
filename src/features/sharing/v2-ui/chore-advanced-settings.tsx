import { SettingsAction } from '../../../components/settings-controls';
import { SettingsHeader } from '../../../components/settings-header';
import { router, useFocusEffect, usePreventRemove } from 'expo-router';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { SectionHeading, palette, typography } from '../../../components/planner-ui';
import type { V2GroupScreenModel, V2GroupController } from '../v2/controller';
import { V2FormScrollView } from './form-controls';
import { V2SettingsDraftCache, type RetainedV2Draft } from './settings-draft-cache';
import { V2ConfigurationEditor } from './configuration-editor';
import { V2ChoreDetailsEditor } from './chore-details-editor';
import { V2DateRightsEditor } from './date-rights-editor';

/** All uncommon controls are directly visible after a single navigation from basic settings. */
export function V2ChoreAdvancedSettings({ model: source, controller, choreId, onSaved, onBack, development = false, header }: {
  model: V2GroupScreenModel; controller: V2GroupController; choreId: string; onSaved(): Promise<void>; onBack(): void; development?: boolean; header?: ReactNode;
}) {
  const drafts = useMemo(() => new Map<string, RetainedV2Draft>(), []); const pending = useRef(false); const allow = useRef(() => {});
  const [error, setError] = useState<string | null>(null);
  const leave = async (navigate: () => void) => {
    if (pending.current) return; pending.current = true; let departed = false; setError(null);
    try {
      for (const store of drafts.values()) void store.navigateAfterSave(() => {});
      allow.current(); navigate(); departed = true;
    } catch { setError('画面を移動できませんでした。もう一度お試しください。'); }
    finally { if (!departed) pending.current = false; }
  };
  const disable = usePreventRemove(true, ({ repeat }) => { void leave(repeat); });
  useLayoutEffect(() => { allow.current = disable; }, [disable]);
  useFocusEffect(useCallback(() => {
    pending.current = false;
    for (const draft of drafts.values()) draft.resumeNavigation();
    return () => { for (const draft of drafts.values()) void draft.navigateAfterSave(() => {}); };
  }, [drafts]));
  const model = { ...source, dateRights: source.choreDateRights?.find(row => row.choreId === choreId) };
  const rotation = model.configurations.find(row => row.choreId === choreId)?.configuration?.policy.assignment.rotation;
  const current = rotation ? model.plan.occurrences.find(round => round.choreId === choreId && !round.completed && round.subjects.some(subject => !subject.automaticBacklog || subject.automaticBacklog === 'pending')) : undefined;
  return <V2SettingsDraftCache.Provider value={drafts}><V2FormScrollView contentContainerStyle={{ padding: 18, gap: 16, paddingBottom: 32 }}
    header={<SettingsHeader title="詳細設定" onBack={() => void leave(onBack)} />}>
    {header}
    {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : null}
    {model.viewerUserId === model.adminUserId ? <View style={{ gap: 12 }}><SectionHeading title="日時変更の権限" level="subsection" />
      <V2DateRightsEditor embedded unfolded model={model} choreId={choreId} controller={controller} onSaved={onSaved} onBack={onBack} />
    </View> : null}
    <V2ConfigurationEditor advancedOnly model={model} choreId={choreId} controller={controller} onSaved={onSaved} />
    {current?.subjects[0] ? <SettingsAction title="今回の担当を変更" placement="page" onPress={() => void leave(() => router.push({ pathname: development ? '/development/sharing-v2-preview/assignment' : '/group-v2/assignment', params: { occurrenceId: current.id, subjectId: current.subjects[0].id, anchorDate: current.anchorDate } }))} /> : null}
    <V2ChoreDetailsEditor embedded unfolded model={model} choreId={choreId} controller={controller} onSaved={onSaved} onBack={onBack} />
  </V2FormScrollView></V2SettingsDraftCache.Provider>;
}
