import { StyleSheet, Text, View } from 'react-native';
import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { WorkspaceContext } from '../contexts/workspace-context';
import { GroupIcon, PersonIcon } from './group-icon';
import { palette, typography } from './planner-ui';
import { ChoreAudiencePicker } from './chore-audience-picker';
import type { ChoreDefinition } from '../domain/chores/types';

/** Lives in the fixed settings header, once per document. */
export function SettingsAudience({ groupName, chore, navigate }: {
  groupName?: string; chore?: ChoreDefinition; navigate?: (navigate: () => void, canNavigate?: () => boolean) => Promise<void>;
}) {
  const context = useContext(WorkspaceContext);
  const latestContext = useRef(context);
  useLayoutEffect(() => { latestContext.current = context; }, [context]);
  const [busy, setBusy] = useState(false); const running = useRef(false);
  const group = context?.group;
  const joined = group && group.userId === context?.userId && ['active', 'creating'].includes(group.status);
  if (joined && navigate) return <ChoreAudiencePicker value={groupName === undefined ? 'personal' : 'shared'} purpose="settings" disabled={busy}
    onChange={async audience => {
      if (running.current) return; running.current = true; setBusy(true);
      const target = chore ? { id: chore.id, matchName: chore.name, matchCategory: chore.category } : { id: 'first' };
      try {
        const canNavigate = () => {
          const current = latestContext.current;
          return current?.userId === group.userId && current.group?.userId === group.userId && current.group.groupId === group.groupId
            && ['active', 'creating'].includes(current.group.status);
        };
        await navigate(() => router.replace(audience === 'personal'
            ? { pathname: '/settings/chore/[id]', params: { ...target, source: 'personal' } }
            : { pathname: '/sharing/chore-settings/[id]', params: { ...target, groupId: group.groupId } }), canNavigate);
      } finally { running.current = false; setBusy(false); }
    }} />;
  if (groupName === undefined && !joined) return null;
  return <View style={styles.audience} accessibilityLabel={groupName === undefined ? '個人用' : `グループ用 · ${groupName}`}><View aria-hidden>{groupName === undefined ? <PersonIcon size={21} /> : <GroupIcon size={26} />}</View>
    <Text numberOfLines={1} style={styles.label}>{groupName === undefined ? '個人用' : 'グループ用'}</Text></View>;
}
const styles = StyleSheet.create({
  audience: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexShrink: 1 },
  label: { ...typography.label, color: palette.muted, flexShrink: 1 },
});
