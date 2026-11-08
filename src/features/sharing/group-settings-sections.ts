export const groupSettingsTitles = {
  chores: '家事ごとの設定', requests: '日時・担当変更の申請', members: 'メンバー・招待', sync: '同期・復旧',
} as const;
export type GroupSettingsSection = keyof typeof groupSettingsTitles;
export function groupSettingsSection(value: unknown): GroupSettingsSection | undefined {
  return typeof value === 'string' && Object.hasOwn(groupSettingsTitles, value) ? value as GroupSettingsSection : undefined;
}
export function groupSettingsDestination(groupId: string, section: GroupSettingsSection) {
  return { pathname: '/sharing/group/[groupId]' as const, params: { groupId, section } };
}
