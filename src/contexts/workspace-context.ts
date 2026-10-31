import { createContext } from 'react';
import type { SharedWorkspace } from '../platform/sharing/workspaces';
import type { SharingWorkspaceRecord } from '../platform/storage/sharing-registry';
export interface WorkspaceContextValue {
  active: SharedWorkspace | null; group: SharingWorkspaceRecord | null; userId: string | null; ready: boolean; error: string | null;
  refreshSharing: () => Promise<void>;
}
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
