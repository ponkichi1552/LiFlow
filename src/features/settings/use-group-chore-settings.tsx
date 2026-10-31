import { useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { openSharedWorkspace, subscribeSharingChanges } from '@/platform/sharing/workspaces';
import type { SharingSelection } from '../sharing/workspace-selection';
import { createGroupChoreSettingsSource } from './group-chore-settings-source';
import { useOptionalWorkspaceDisplay } from '../sharing/v2-ui/workspace-data';
import { WorkspaceContext } from '../../contexts/workspace-context';

export function useGroupChoreSettings(selection: SharingSelection) {
  const { userId, groupId } = selection;
  const binding = useOptionalWorkspaceDisplay(); const context = useContext(WorkspaceContext);
  const display = binding?.workspace?.userId === userId && binding.workspace.groupId === groupId ? binding : null;
  const prepared = useMemo(() => display ? { invalidate: display.invalidate, readModel: async () => (await (await display.loadSession()).readModel({ management: true, choreSettings: true })) } : undefined, [display]);
  const source = useMemo(() => createGroupChoreSettingsSource({ userId, groupId }, openSharedWorkspace, prepared), [userId, groupId, prepared]);
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  useFocusEffect(useCallback(() => {
    void source.refresh();
    const unsubscribe = display ? display.subscribe(() => { void source.refresh(); }) : subscribeSharingChanges(scope => { if (scope?.userId === userId && scope.groupId === groupId) void source.refresh(); });
    return () => { unsubscribe(); source.invalidate(); };
  }, [source, userId, groupId, display]));
  const cached = display?.peek({ management: true, choreSettings: true });
  const initial = cached && display?.workspace && context?.group?.userId === userId && context.group.groupId === groupId
    ? { workspace: display.workspace, record: context.group, protocol: 2 as const, model: cached.model } : null;
  return { ...state, snapshot: state.snapshot ?? initial, source };
}
