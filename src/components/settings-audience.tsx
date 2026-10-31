import { StyleSheet, Text, View } from 'react-native';
import { useContext } from 'react';
import { WorkspaceContext } from '../contexts/workspace-context';
import { GroupIcon, PersonIcon } from './group-icon';
import { palette, typography } from './planner-ui';

/** Lives in the fixed settings header, once per document. */
export function SettingsAudience({ groupName }: { groupName?: string }) {
  const context = useContext(WorkspaceContext);
  const group = context?.group;
  const joined = group && group.userId === context?.userId && ['active', 'creating'].includes(group.status);
  if (groupName === undefined && !joined) return null;
  return <View style={styles.audience} accessibilityLabel={groupName === undefined ? '個人用' : `グループ用 · ${groupName}`}><View aria-hidden>{groupName === undefined ? <PersonIcon size={21} /> : <GroupIcon size={26} />}</View>
    <Text numberOfLines={1} style={styles.label}>{groupName === undefined ? '個人用' : 'グループ用'}</Text></View>;
}
const styles = StyleSheet.create({
  audience: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexShrink: 1 },
  label: { ...typography.label, color: palette.muted, flexShrink: 1 },
});
