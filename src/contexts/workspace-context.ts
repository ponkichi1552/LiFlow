import { createContext } from 'react';
import type { SharedWorkspace } from '../platform/sharing/workspaces';
import type { SharingWorkspaceRecord } from '../platform/storage/sharing-registry';
import type { V2GroupUiSession } from '../features/sharing/v2-ui/screen-session';
export interface WorkspaceContextValue {
  active: SharedWorkspace | null; group: SharingWorkspaceRecord | null; userId: string | null; ready: boolean; error: string | null;
  refreshSharing: () => Promise<void>;
  restoration?: 'waiting' | 'failed' | null;
  completeInitialDisplay?: (workspace: SharedWorkspace) => void;
  startupDisplay?: { record: SharingWorkspaceRecord; model: Awaited<ReturnType<V2GroupUiSession['readModel']>> } | null;
}
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
