import { Pressable, StyleSheet, Text, View } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';

export const GROUP_MANAGEMENT_DESTINATIONS = [
  ['日時の変更申請', '/group-v2/requests'], ['担当の変更申請', '/group-v2/assignment-requests'],
  ['グループのルール', '/group-v2/group-rules'], ['この端末の共有通知', '/group-v2/notifications'],
  ['共有家事とGoogle Tasks', '/group-v2/google-tasks'], ['共有予定をGoogleにも表示', '/group-v2/google-calendar'],
  ['個人家事から追加', '/group-v2/personal-copy'], ['ゴミ収集日', '/group-v2/waste'], ['実施履歴', '/group-v2/history'],
] as const;
export function GroupManagementLinks({ busy, onSelect }: { busy: boolean; onSelect: (target: typeof GROUP_MANAGEMENT_DESTINATIONS[number][1]) => void }) {
  return <View>{GROUP_MANAGEMENT_DESTINATIONS.map(([title, target]) => <Pressable key={target} accessibilityRole="button" accessibilityLabel={title} disabled={busy} onPress={() => onSelect(target)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
    <Text style={styles.label}>{title}</Text><Chevron />
  </Pressable>)}</View>;
}
const styles = StyleSheet.create({ row: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border }, label: { ...typography.control, color: palette.ink, flex: 1 }, pressed: { backgroundColor: palette.accentSoft } });
