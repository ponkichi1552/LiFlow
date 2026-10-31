import type { SQLiteDatabase } from 'expo-sqlite';
import type { createSharingCloud } from './firestore-cloud';
import type { DeviceSecretIdentity } from '../../features/sharing/crypto';
import type { createSharedGroupManager } from '../../features/sharing/group-manager';
import type { SharingSyncResult } from '../../features/sharing/synchronizer';
import type { VerifiedSharedRoster } from '../../features/sharing/roster';
import type { SharingSelection } from '../../features/sharing/workspace-selection';
import type { SharingWorkspaceRecord } from '../storage/sharing-registry';
import type { readSharingCheckpoint } from '../storage/sharing-ledger';
import type { V2WorkspaceSession } from '../../features/sharing/v2/workspace-session';
import type { V2ReminderRuntime } from '../../features/sharing/v2/reminder-runtime';
import type { V2GoogleTaskRuntime } from '../../features/sharing/v2/google-tasks-runtime';

export interface SharedWorkspaceOverview {
  timeZone: string; members: { id: string; displayName: string }[]; chores: { id: string; name: string }[]; hasConflicts: boolean;
  recoverySummary?: { heldChanges: number; recoveries: number };
}
interface SharedWorkspaceBase extends SharingSelection {
  cloud: ReturnType<typeof createSharingCloud>; identity: DeviceSecretIdentity;
  record: () => Promise<SharingWorkspaceRecord>; roster: () => VerifiedSharedRoster | undefined;
  sync: (options?: { force?: boolean; budgetMs?: number }) => Promise<SharingSyncResult>;
  checkpoint: () => ReturnType<typeof readSharingCheckpoint>;
  watch: (callback: () => void, failed: (error: unknown) => void) => () => void;
  cancelJoinRequest: () => Promise<void>; maintainHistory: () => Promise<void>;
  readOverview: () => Promise<SharedWorkspaceOverview>; drain: () => Promise<void>;
}
export interface LegacyMigrationWorkspace extends SharedWorkspaceBase {
  protocol: 'migration'; database: SQLiteDatabase; manager: null;
  migration: ReturnType<typeof import('../../features/sharing/v2/live-legacy-migration').createLiveLegacyMigration>;
}
export interface V2SharedWorkspace extends SharedWorkspaceBase {
  protocol: 2; database: SQLiteDatabase; session: V2WorkspaceSession;
  manager: ReturnType<typeof createSharedGroupManager>;
  reminders: () => Promise<V2ReminderRuntime>;
  googleTasks: () => Promise<V2GoogleTaskRuntime>;
  googleCalendar: () => Promise<import('../../features/calendar/shared-google-export').SharedGoogleCalendarExport>;
}
export interface PendingSharedWorkspace extends SharedWorkspaceBase {
  protocol: null; database: null; manager: null;
}
export type SharedWorkspace = LegacyMigrationWorkspace | V2SharedWorkspace | PendingSharedWorkspace;
