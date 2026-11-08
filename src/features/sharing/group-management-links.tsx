import { Pressable, StyleSheet, Text, View } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';
import { SettingsNavigationLink } from '../../components/accordion-section';
import { SettingsRow } from '../settings/settings-navigation';

/** Group-wide controls and this user's integrations have separate entry points. */
export const GROUP_MANAGEMENT_SECTIONS = {
  common: [['グループ名・ルール', '/group-v2/group-rules']],
  google: [['共有家事のGoogle Tasks連携', '/group-v2/google-tasks'], ['共有予定のGoogle表示', '/group-v2/google-calendar']],
  notifications: [['共有家事の通知', '/group-v2/notifications']],
} as const;
type Section = keyof typeof GROUP_MANAGEMENT_SECTIONS;
type Target = typeof GROUP_MANAGEMENT_SECTIONS[Section][number][1];
export function GroupManagementLinks({ section, busy, onSelect, list = false }: { section: Section; busy: boolean; onSelect: (target: Target) => void; list?: boolean }) {
  if (list) return <View>{GROUP_MANAGEMENT_SECTIONS[section].map(([title, target]) => <SettingsRow key={target} title={title} disabled={busy} onPress={() => onSelect(target)} />)}</View>;
  if (section === 'common') return <SettingsNavigationLink title={GROUP_MANAGEMENT_SECTIONS.common[0][0]} disabled={busy} onPress={() => onSelect(GROUP_MANAGEMENT_SECTIONS.common[0][1])} />;
  return <View>{GROUP_MANAGEMENT_SECTIONS[section].map(([title, target]) => <Pressable key={target} accessibilityRole="button" accessibilityLabel={title} disabled={busy} onPress={() => onSelect(target)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
    <Text style={styles.label}>{title}</Text><Chevron />
  </Pressable>)}</View>;
}
const styles = StyleSheet.create({ row: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border }, label: { ...typography.control, color: palette.ink, flex: 1 }, pressed: { backgroundColor: palette.accentSoft } });
