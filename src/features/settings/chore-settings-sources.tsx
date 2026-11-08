import { router } from 'expo-router';
import { useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { usePersonalSettingsData } from '@/hooks/use-personal-settings-data';
import { resetAllChoreSchedules, setChoresEnabled } from '@/platform/storage/repository';
import { ScheduleResetAction } from '@/components/schedule-reset-action';
import type { SharingSelection } from '../sharing/workspace-selection';
import { palette, typography } from '@/components/planner-ui';
import { GroupIcon, PersonIcon } from '@/components/group-icon';
import { plannerColorsForScheme } from '@/components/planner-theme';
import { ChoreToggleList } from './chore-toggle-list';
import { useGroupChoreSettings } from './use-group-chore-settings';
import { personalChoiceSourceId } from './group-personal-chore-choices';
import { SettingsAction } from '@/components/settings-controls';
import { V2WasteScreen } from '../sharing/v2-ui/waste-screen';
import type { V2MutationOutcome } from '../sharing/v2-ui/mutation-outcome';

export type ChoreSettingsSource = 'personal' | 'group';
export function useChoreSettingsGroup(group?: SharingSelection) {
  const context = useContext(WorkspaceContext);
  const record = context?.group;
  const available = record && record.userId === context?.userId && ['active', 'creating'].includes(record.status) && (!group || record.groupId === group.groupId);
  return available ? record : undefined;
}
export function ChoreSettingsSourcePicker({ value, onChange, disabled = false }: {
  value: ChoreSettingsSource; onChange(source: ChoreSettingsSource): void; disabled?: boolean;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  return <View accessibilityRole="tablist" accessibilityLabel="家事設定の対象" style={styles.picker}>
    {(['personal', 'group'] as const).map(source => <Pressable key={source} accessibilityRole="tab" accessibilityLabel={source === 'personal' ? '個人用の家事設定' : 'グループ用の家事設定'}
      accessibilityState={{ selected: value === source, disabled }} disabled={disabled} onPress={() => onChange(source)}
      style={({ pressed }) => [styles.tab, { borderBottomColor: value === source ? colors.accent : colors.border }, pressed && { backgroundColor: colors.accentSoft }]}>
      <View aria-hidden>{source === 'personal' ? <PersonIcon size={17} /> : <GroupIcon size={22} />}</View>
      <Text style={[styles.tabText, value === source && { color: colors.accent, fontWeight: '700' }]}>{source === 'personal' ? '個人用' : 'グループ用'}</Text>
    </Pressable>)}
  </View>;
}

/** A controlled source lets the standalone page keep its selector outside the scroll area. */
export function ChoreSettingsSources({ first = 'personal', group, source, onPendingChange }: {
  first?: ChoreSettingsSource; group?: SharingSelection; source?: ChoreSettingsSource; onPendingChange?(pending: boolean): void;
}) {
  const record = useChoreSettingsGroup(group);
  const [selected, setSelected] = useState(first);
  const [personalExpanded, setPersonalExpanded] = useState<Set<string>>(new Set());
  const [groupExpanded, setGroupExpanded] = useState<Set<string>>(new Set());
  const pendingChanged = (value: boolean) => { onPendingChange?.(value); };
  const groupPane = record ? <GroupChoreSettings key={`${record.userId}:${record.groupId}:${record.localGeneration}`} selection={record}
    expanded={groupExpanded} setExpanded={setGroupExpanded} onPendingChange={pendingChanged} includeWaste={Boolean(group)} /> : null;
  if (group) return groupPane;
  const active = record ? source ?? selected : 'personal';
  return <View style={styles.body}>
    {record && source === undefined ? <ChoreSettingsSourcePicker value={active} onChange={setSelected} /> : null}
    {active === 'group' ? groupPane : <PersonalChoreSettings shared={Boolean(record)} expanded={personalExpanded} setExpanded={setPersonalExpanded} onPendingChange={pendingChanged} />}
  </View>;
}

type PaneProps = Pick<Parameters<typeof ChoreToggleList>[0], 'expanded' | 'setExpanded' | 'onPendingChange'>;
function PersonalChoreSettings({ shared = false, expanded, setExpanded, onPendingChange }: PaneProps & { shared?: boolean }) {
  const data = usePersonalSettingsData();
  if (!data.snapshot) return <Text style={styles.hint}>設定を読み込んでいます。</Text>;
  return <View style={styles.body}>{shared ? <Text style={styles.hint}>共通の家事はグループ設定を優先</Text> : null}
    {data.error ? <Text accessibilityRole="alert" style={styles.error}>{data.error}</Text> : null}
    <ChoreToggleList chores={data.snapshot.chores} expanded={expanded} setExpanded={setExpanded} personalSelection onPendingChange={onPendingChange}
      save={async (ids, enabled) => { await setChoresEnabled(data.database, ids, enabled); await data.refresh(); return { refreshed: !data.readError() }; }}
      retryRead={async () => { await data.refresh(); return !data.readError(); }}
      onOpen={id => router.push({ pathname: '/settings/chore/[id]', params: { id, source: 'personal' } })} />
    <SettingsAction title="家事を追加" accessibilityLabel="新しい個人家事を追加" placement="page" compact={false} onPress={() => router.push('/settings/add-chore')} />
    <ScheduleResetAction all onReset={async () => { onPendingChange?.(true); try { await resetAllChoreSchedules(data.database); await data.refresh(); if (data.readError()) throw new Error(data.readError()!); } finally { onPendingChange?.(false); } }} />
  </View>;
}

function GroupChoreSettings({ selection, expanded, setExpanded, onPendingChange, includeWaste = false }: PaneProps & { selection: SharingSelection; includeWaste?: boolean }) {
  const data = useGroupChoreSettings(selection, includeWaste);
  const [choreBusy, setChoreBusy] = useState(false); const choreSaving = useRef(false); const [wasteBusy, setWasteBusy] = useState(false); const wasteSaving = useRef(false);
  const pendingChanged = (pending: boolean) => { choreSaving.current = pending; setChoreBusy(pending); onPendingChange?.(pending); };
  const opening = useRef(false); const [openError, setOpenError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const value = data.snapshot;
  if (!value) return <View style={styles.body}>{data.loading ? <ActivityIndicator color={palette.accent} /> : <>
    <Text accessibilityRole="alert" style={styles.error}>{data.error}</Text>
    <SettingsAction title="グループの家事設定を再読込" placement="page" onPress={() => void data.source.refresh()} /></>}</View>;
  const readOnly = value.model.viewerUserId !== value.model.adminUserId;
  const open = async (id: string) => {
    if (wasteSaving.current) return;
    if (!personalChoiceSourceId(id)) { router.push({ pathname: '/settings/chore/[id]', params: { id, source: 'shared', groupId: selection.groupId } }); return; }
    if (opening.current) return;
    opening.current = true; setOpenError(null); onPendingChange?.(true);
    try {
      const selected = (await data.source.addPersonalChore(id, false)).id;
      if (alive.current) router.push({ pathname: '/settings/chore/[id]', params: { id: selected, source: 'shared', groupId: selection.groupId } });
    } catch (cause) { if (alive.current) setOpenError(cause instanceof Error ? cause.message : '家事の設定を開けませんでした。'); }
    finally { opening.current = false; if (alive.current) onPendingChange?.(false); }
  };
  const performWaste = async (work: () => Promise<unknown>): Promise<V2MutationOutcome> => {
    if (wasteSaving.current || choreSaving.current || opening.current) return { committed: false, refreshed: false, error: new Error('変更を保存中です。') };
    wasteSaving.current = true; setWasteBusy(true); onPendingChange?.(true);
    try { return await data.source.perform(work); }
    finally { wasteSaving.current = false; if (alive.current) { setWasteBusy(false); onPendingChange?.(false); } }
  };
  return <View style={styles.body}>{readOnly ? <Text style={styles.hint}>有効・無効と周期は管理者が変更できます。</Text> : null}
    {openError ? <Text accessibilityRole="alert" style={styles.error}>{openError}</Text> : null}
    {value.personalChoicesError ? <><Text accessibilityRole="alert" style={styles.error}>{value.personalChoicesError}</Text>
      <SettingsAction title="追加できる家事を再読込" placement="page" onPress={() => void data.source.refresh()} /></> : null}
    <ChoreToggleList chores={[...value.model.plan.chores, ...(value.personalChoices ?? [])]}
      expanded={expanded} setExpanded={setExpanded} readOnly={readOnly || wasteBusy} onPendingChange={pendingChanged}
      save={data.source.saveEnabled} retryRead={async () => { await data.source.refresh(); return !data.source.getSnapshot().error; }}
      onOpen={id => void open(id)} />
    <SettingsAction title="家事を追加" accessibilityLabel="新しい共有家事を追加" placement="page" compact={false} disabled={wasteBusy} onPress={() => router.push('/group-v2/add-chore')} />
    {!readOnly ? <ScheduleResetAction all disabled={wasteBusy} onReset={async () => { pendingChanged(true); try { await data.source.resetSchedules(); } finally { pendingChanged(false); } }} /> : null}
    {includeWaste ? <View style={{ gap: 12, marginTop: 20 }}><Text accessibilityRole="header" style={[typography.label, { color: palette.ink, fontWeight: '600' }]}>ゴミ収集日</Text>
      <V2WasteScreen embedded model={value.model} actions={value.workspace.session.controller.actions} busy={wasteBusy || choreBusy} perform={performWaste} onBack={() => {}} />
    </View> : null}
  </View>;
}
const styles = StyleSheet.create({
  body: { gap: 10 }, picker: { flexDirection: 'row', gap: 10 },
  tab: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderBottomWidth: 2 },
  tabText: { ...typography.label, color: palette.muted },
  hint: { ...typography.caption, color: palette.muted }, error: { ...typography.caption, color: palette.warning },
});
