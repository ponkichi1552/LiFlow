import { randomUUID } from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Household } from '../../domain/shared/types';
import { createCompletionIntents } from '../../features/planner/completion-intents.ts';
import type { CompletionIntent } from '../../features/planner/completion-intents';
import { captureCompletionTarget, completionIntentDigest, personalCompletionKey } from '../../features/planner/completion-command.ts';
import type { CompletionTarget } from '../../features/planner/completion-command';
import { protectedCompletionIntentStore } from './completion-intent-store.ts';
import { LOCAL_HOUSEHOLD_ID, loadPlannerSnapshot, setPersonalDateTaskCompletedIntent } from './repository';
import { syncGoogleTasksAfterLocalCompletion } from '../../features/google-sync/coordinator';
import type { V2GroupUiSession } from '../../features/sharing/v2-ui/screen-session';

function completionRuntime(scope: string, apply: (intent: Readonly<CompletionIntent<CompletionTarget>>, guard: () => void) => Promise<void>) {
  const owners = new Set<() => boolean>();
  const readers = new Set<{ active: () => boolean; read: () => Promise<void> }>();
  const current = () => [...owners].some(check => { try { return check(); } catch { return false; } });
  const guard = () => { if (!current()) throw new Error('操作する保存先が変わりました。'); };
  const queue = createCompletionIntents<CompletionTarget>({
    store: protectedCompletionIntentStore(scope, captureCompletionTarget), capture: captureCompletionTarget,
    makeId: () => `completion-intent.${randomUUID()}`, now: () => new Date(), isCurrent: current,
    apply: async intent => { guard(); await apply(intent, guard); },
    refresh: async () => {
      const visible = [...readers].filter(reader => reader.active());
      if (!visible.length) return false;
      await Promise.all(visible.map(reader => reader.read()));
    },
  });
  return {
    queue,
    acquire(isCurrent: () => boolean = () => true) {
      owners.add(isCurrent); void queue.activate();
      return () => { owners.delete(isCurrent); if (!owners.size) queue.deactivate(); };
    },
    watchDisplay(read: () => Promise<void>, active: () => boolean = () => true) {
      const reader = { read, active }; readers.add(reader); queue.retryRead();
      return () => { readers.delete(reader); };
    },
  };
}
export type CompletionIntentRuntime = ReturnType<typeof completionRuntime>;
const personal = new Map<string, { runtime: CompletionIntentRuntime; database: SQLiteDatabase }>();

/** The installation's household creation identity survives route changes and
 * rejects old Keychain requests when iOS keeps Keychain data after reinstall.
 * Personal requests remain local and independent of group login or departure.
 */
export function personalCompletionIntents(database: SQLiteDatabase, household: Household): CompletionIntentRuntime {
  if (household.id !== LOCAL_HOUSEHOLD_ID || !Number.isFinite(Date.parse(household.createdAt))) throw new Error('個人家事の保存先を確認できません。');
  const scope = JSON.stringify(['personal', household.id, household.createdAt]);
  const householdCreatedAt = household.createdAt;
  const existing = personal.get(scope);
  if (existing) { existing.database = database; return existing.runtime; }
  const binding = { database, runtime: null as unknown as CompletionIntentRuntime };
  binding.runtime = completionRuntime(scope, async (intent, guard) => {
    const target = captureCompletionTarget(intent.target);
    if (target.kind !== 'personal' || intent.key !== personalCompletionKey(target.command.revision)) throw new Error('個人家事の回を確認できません。');
    const db = binding.database;
    const changed = await setPersonalDateTaskCompletedIntent(db, { ...target.command, completed: intent.completed },
      { id: intent.id, digest: completionIntentDigest(scope, intent), householdCreatedAt, createdAt: intent.createdAt }, guard);
    if (changed) syncGoogleTasksAfterLocalCompletion(db);
    // Undo can invalidate its old generated entry. Prepare the canonical entry
    // before a queued re-completion, without holding up the visible checkbox.
    if (!intent.completed) {
      guard();
      try { await loadPlannerSnapshot(db); } catch { /* The committed receipt remains authoritative; display refresh can retry. */ }
    }
  });
  personal.set(scope, binding); return binding.runtime;
}

export function sharedCompletionIntents(input: { userId: string; groupId: string; generation?: string;
  loadSession: () => Promise<V2GroupUiSession> }): CompletionIntentRuntime {
  const scope = JSON.stringify(['shared', input.userId, input.groupId, input.generation ?? 'initial']);
  return completionRuntime(scope, async (intent, guard) => {
    const target = captureCompletionTarget(intent.target);
    if (target.kind !== 'shared') throw new Error('共有家事の保存先を確認できません。');
    const session = await input.loadSession(); guard();
    if (session.groupId !== input.groupId || session.userId !== input.userId) throw new Error('操作する共有グループが変わりました。');
    const { v2OccurrenceId, v2SubjectOccurrenceId } = await import('../../features/sharing/v2/occurrence-id'); guard();
    if (intent.key !== `shared:${v2SubjectOccurrenceId(v2OccurrenceId(input.groupId, target.ref.choreId, target.ref.anchorDate), target.ref.subjectUserId)}`) {
      throw new Error('共有家事の回を確認できません。');
    }
    await session.controller.actions.setCompletedIntent({ id: intent.id, digest: completionIntentDigest(scope, intent) }, target.ref,
      intent.completed, { createdAt: intent.createdAt, expectedAssigneeIds: target.expectedAssigneeIds });
  });
}
