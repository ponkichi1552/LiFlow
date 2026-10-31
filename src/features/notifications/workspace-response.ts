import { sharedGoogleNamespace } from '../google-sync/workspace-policy.ts';
import { v2NativeWorkspaceNamespace } from '../sharing/v2/native-identity.ts';

export function isPlannerNotification(data: unknown): data is { kind: string; workspace?: unknown } {
  return Boolean(data && typeof data === 'object' && 'kind' in data && ['daily-housework-digest', 'v2-housework-digest', 'v2-housework-completed'].includes(String(data.kind)));
}

/** Notification metadata contains only an opaque scope; never infer a group from a chore name. */
export function notificationWorkspace(data: unknown, userId: string | null,
  group: { userId: string; groupId: string; status: string } | null): { userId: string; groupId: string } | null | undefined {
  if (!isPlannerNotification(data)) return undefined;
  if (!('workspace' in data)) return data.kind === 'daily-housework-digest' ? null : undefined;
  if (!userId || typeof data.workspace !== 'string' || !/^[a-f0-9]{64}$/u.test(data.workspace)) return undefined;
  const matches = group?.userId === userId && group.status === 'active'
    && (data.kind === 'daily-housework-digest' ? sharedGoogleNamespace(group.userId, group.groupId) : v2NativeWorkspaceNamespace(group.userId, group.groupId)) === data.workspace;
  return matches && group ? { userId: group.userId, groupId: group.groupId } : undefined;
}
