type ChoreSettingsSource = 'personal' | 'group';

// Session-only UI preference. Account, group and local generation must never share a selection.
const selections = new Map<string, ChoreSettingsSource>();
export const choreSourceScope = (group?: { userId: string; groupId: string; localGeneration?: string | number }) => group
  ? JSON.stringify([group.userId, group.groupId, group.localGeneration ?? '']) : 'personal';
export const readChoreSource = (scope: string): ChoreSettingsSource => selections.get(scope) ?? 'personal';
export function rememberChoreSource(scope: string, source: ChoreSettingsSource) {
  if (selections.size > 20) selections.clear();
  selections.set(scope, source);
}
