import { router } from 'expo-router';
import { useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { usePlannerData } from '@/hooks/use-planner-data';
import { setChoresEnabled } from '@/platform/storage/repository';
import type { SharingSelection } from '../sharing/workspace-selection';
import { AppButton, palette, typography } from '@/components/planner-ui';
import { Chevron } from '@/components/chevron';
import { GroupIcon, PersonIcon } from '@/components/group-icon';
import { ChoreToggleList } from './chore-toggle-list';
import { useGroupChoreSettings } from './use-group-chore-settings';

/** Audience is explicit at both entry points; editing never switches the displayed workspace. */
export function ChoreSettingsSources({ first = 'personal', group }: { first?: 'personal' | 'group'; group?: SharingSelection }) {
  const context = useContext(WorkspaceContext);
  const record = context?.group;
  const available = record && record.userId === context?.userId && ['active', 'creating'].includes(record.status) && (!group || record.groupId === group.groupId);
  if (!available) return group ? null : <PersonalChoreSettings />;
  if (group) return <GroupChoreSettings selection={record} />;
  const personal = <SettingsAudience key="personal" title="個人用" icon={<PersonIcon size={20} />} initialOpen={first === 'personal'}>
    <PersonalChoreSettings shared />
  </SettingsAudience>;
  const shared = <SettingsAudience key={`${record.userId}:${record.groupId}:${record.localGeneration}`}
    title={`グループ用 · ${record.displayName}`} icon={<GroupIcon size={24} />} initialOpen={first === 'group'}>
    <GroupChoreSettings selection={record} />
  </SettingsAudience>;
  return <View style={styles.sources}>{first === 'personal' ? [personal, shared] : [shared, personal]}</View>;
}

function SettingsAudience({ title, icon, initialOpen, children }: { title: string; icon: ReactNode; initialOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initialOpen);
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}の設定を${open ? '閉じる' : '開く'}`} accessibilityState={{ expanded: open }}
      onPress={() => setOpen(value => !value)} style={styles.audience}>
      <View aria-hidden style={styles.icon}>{icon}</View><Text style={styles.title}>{title}</Text><Chevron direction={open ? 'up' : 'down'} />
    </Pressable>
    {open ? children : null}
  </View>;
}

function PersonalChoreSettings({ shared = false }: { shared?: boolean }) {
  const data = usePlannerData({ personal: true });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (!data.snapshot) return <Text style={styles.hint}>設定を読み込んでいます。</Text>;
  return <View style={styles.body}>{shared ? <Text style={styles.hint}>自分だけに保存されます。共通の家事は、ホームではグループの設定で表示します。</Text> : null}
    {data.error ? <Text accessibilityRole="alert" style={styles.error}>{data.error}</Text> : null}
    <ChoreToggleList chores={data.snapshot.chores} expanded={expanded} setExpanded={setExpanded}
      save={async (ids, enabled) => { await setChoresEnabled(data.database, ids, enabled); await data.refresh(); return { refreshed: !data.readError() }; }}
      retryRead={async () => { await data.refresh(); return !data.readError(); }}
      onOpen={id => router.push({ pathname: '/settings/chore/[id]', params: { id, source: 'personal' } })} />
  </View>;
}

function GroupChoreSettings({ selection }: { selection: SharingSelection }) {
  const data = useGroupChoreSettings(selection);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const value = data.snapshot;
  if (!value) return <View style={styles.body}>{data.loading ? <ActivityIndicator color={palette.accent} /> : <>
    <Text accessibilityRole="alert" style={styles.error}>{data.error}</Text>
    <AppButton title="グループの家事設定を再読込" compact variant="quiet" onPress={() => void data.source.refresh()} /></>}</View>;
  const readOnly = value.model.viewerUserId !== value.model.adminUserId;
  return <View style={styles.body}><Text style={styles.hint}>{readOnly ? '名前・手順は編集できます。有効・無効と周期は管理者が変更します。' : 'このグループのメンバーに共有されます。'}</Text>
    <ChoreToggleList chores={value.model.plan.chores}
      expanded={expanded} setExpanded={setExpanded} readOnly={readOnly}
      save={data.source.saveEnabled} retryRead={async () => { await data.source.refresh(); return !data.source.getSnapshot().error; }}
      onOpen={id => router.push({ pathname: '/sharing/chore-settings/[id]', params: { id, groupId: selection.groupId } })} />
  </View>;
}
const styles = StyleSheet.create({
  sources: { gap: 10 }, body: { gap: 10 },
  audience: { flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 9 },
  icon: { width: 27, alignItems: 'center', justifyContent: 'center' },
  title: { ...typography.subheading, color: palette.ink, fontWeight: '700', flex: 1 },
  hint: { ...typography.caption, color: palette.muted }, error: { ...typography.caption, color: palette.warning },
});
