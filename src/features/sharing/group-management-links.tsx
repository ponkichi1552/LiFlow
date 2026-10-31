import { View } from 'react-native';
import { AppButton } from '../../components/planner-ui';

export const GROUP_MANAGEMENT_DESTINATIONS = [
  ['日時の変更申請', '/group-v2/requests'], ['担当の変更申請', '/group-v2/assignment-requests'],
  ['グループのルール', '/group-v2/group-rules'], ['この端末の共有通知', '/group-v2/notifications'],
  ['共有家事とGoogle Tasks', '/group-v2/google-tasks'], ['共有予定をGoogleにも表示', '/group-v2/google-calendar'],
  ['個人家事から追加', '/group-v2/personal-copy'], ['ゴミ収集日', '/group-v2/waste'], ['実施履歴', '/group-v2/history'],
] as const;
export function GroupManagementLinks({ busy, onSelect }: { busy: boolean; onSelect: (target: typeof GROUP_MANAGEMENT_DESTINATIONS[number][1]) => void }) {
  return <View style={{ gap: 8 }}>{GROUP_MANAGEMENT_DESTINATIONS.map(([title, target]) => <AppButton key={target} title={title} variant="quiet" compact disabled={busy} onPress={() => onSelect(target)} />)}</View>;
}
