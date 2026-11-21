import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState, View } from 'react-native';
import { palette } from '@/components/planner-ui';
import { currentSharingWorkspace, hasSharingSessionEnabled, openSharedWorkspace, readSharingSelection,
  saveSharingSelection, sharingSessionUser, subscribeSharingChanges, syncSharingWorkspace } from '@/platform/sharing/workspaces';
import type { SharedWorkspace } from '@/platform/sharing/workspaces';
import type { SharingWorkspaceRecord } from '@/platform/storage/sharing-registry';
import { observeSharingUser } from '@/platform/sharing/auth';
import { isSharingConfigured } from '@/platform/sharing/firebase-services';
import { WorkspaceContext } from '@/contexts/workspace-context';
import type { WorkspaceContextValue } from '@/contexts/workspace-context';
import { startPrivateCalendarForeground, syncKnownPrivateCalendar } from '@/platform/sharing/private-calendar-sync';
import { traceStartup } from '@/platform/diagnostics/startup-timing';
import { createInitialDisplayGate, waitForInitialFrame } from '@/features/planner/initial-display-gate';
import { canShowPersonalStartup, readSavedStartupDisplay, startupDisplayCache } from '@/platform/sharing/startup-display';
import { createDemandWorker } from '@/features/google-sync/demand-worker';
import { privateCalendarWaitRetry } from '@/features/sharing/private-calendar/foreground-observer';
import { isSharingInitialSyncPending } from '@/features/sharing/workspace-initial-sync';

/** Personal data stays mounted; a membership adds shared data to the same four tabs. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const displayGate = useMemo(() => createInitialDisplayGate<SharedWorkspace>(), []);
  const [startupDisplay, setStartupDisplay] = useState<WorkspaceContextValue['startupDisplay']>(null);
  const displayed = useRef<WorkspaceContextValue['startupDisplay']>(null);
  const showStartupDisplay = useCallback((value: WorkspaceContextValue['startupDisplay']) => {
    displayed.current = value; setStartupDisplay(value);
  }, []);
  const completeInitialDisplay = useCallback((workspace: SharedWorkspace) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => displayGate.complete(workspace));
    else setTimeout(() => displayGate.complete(workspace), 0);
    if (activeRef.current === workspace) showStartupDisplay(null);
  }, [displayGate, showStartupDisplay]);
  const [active, setActive] = useState<SharedWorkspace | null>(null);
  const activeRef = useRef<SharedWorkspace | null>(null);
  const [group, setGroup] = useState<SharingWorkspaceRecord | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [restoration, setRestoration] = useState<'waiting' | 'failed' | null>(null);
  const [initialSyncPending, setInitialSyncPending] = useState(false);
  const [ready, setReady] = useState(false); const [error, setError] = useState<string | null>(null);
  const alive = useRef(true); const revision = useRef(0);
  const authenticatedRevision = useRef<{ revision: number; userId: string | null } | null>(null);
  const refreshSharing = useCallback(async function refresh(): Promise<void> {
    if (!isSharingConfigured()) return;
    const current = ++revision.current; const user = await traceStartup('workspace.authentication', sharingSessionUser);
    const check = async () => {
      if (!alive.current || current !== revision.current) return false;
      if ((await sharingSessionUser())?.uid !== user?.uid) { void refresh(); return false; }
      return true;
    };
    try {
      const record = user ? await traceStartup('workspace.membership', currentSharingWorkspace) : null;
      if (!await check()) return;
      const alreadyDisplayed = displayed.current;
      // The authenticated membership and the presentation still have to agree when refreshes overlap.
      const keepStartupDisplay = alreadyDisplayed && record && record.userId === user?.uid
        && startupDisplayCache.canReuse(record, alreadyDisplayed.model);
      if (alreadyDisplayed && !keepStartupDisplay) showStartupDisplay(null);
      if (activeRef.current?.userId !== user?.uid) {
        activeRef.current = null; setActive(null);
        setRestoration(null); setInitialSyncPending(false);
      }
      setGroup(record); setUserId(user?.uid ?? null);
      const eligible = record && ['active', 'creating'].includes(record.status);
      let next = eligible ? activeRef.current : null;
      if (eligible && (next?.userId !== user!.uid || next.groupId !== record.groupId)) {
        if (!keepStartupDisplay) {
          const model = await traceStartup('workspace.savedDisplay', () => startupDisplayCache.read(record));
          if (!await check()) return;
          if (model) {
            // Present only authenticated local ciphertext. This does not construct
            // a writable workspace or skip the real restoration/authority checks.
            showStartupDisplay({ record, model }); setReady(true);
            await waitForInitialFrame(true);
            if (!await check()) return;
          }
        }
        next = await traceStartup('workspace.open', () => openSharedWorkspace(record));
        if (next.protocol === null) next = null;
      }
      if (!await check()) return;
      if (activeRef.current && activeRef.current !== next) await activeRef.current.drain();
      if (!await check()) return;
      if (next) await saveSharingSelection(next);
      else if (!record) await saveSharingSelection(null);
      if (!await check()) return;
      activeRef.current = next; setActive(next); setGroup(record); setUserId(user?.uid ?? null); setError(null); setInitialSyncPending(false);
      authenticatedRevision.current = { revision: current, userId: user?.uid ?? null };
      if (!next) showStartupDisplay(null);
      void import('@/platform/sharing/v2-reminders').then(module => module.clearInactiveV2Reminders(record?.status === 'active' ? [record] : [], async () => {
        if (!await check()) throw new Error('通知を更新するアカウントが変わりました。');
        const latest = await currentSharingWorkspace();
        if (latest?.groupId !== record?.groupId || latest?.userId !== record?.userId || latest?.status !== record?.status || latest?.localGeneration !== record?.localGeneration || latest?.v2Migration?.databaseGeneration !== record?.v2Migration?.databaseGeneration) throw new Error('通知を更新する所属が変わりました。');
      })).catch(() => undefined);
    } catch (cause) {
      if (!await check()) return;
      if (activeRef.current?.userId !== user?.uid) { activeRef.current = null; setActive(null); setGroup(null); showStartupDisplay(null); }
      setUserId(user?.uid ?? null);
      const pending = isSharingInitialSyncPending(cause); setInitialSyncPending(pending);
      setError(pending ? null : cause instanceof Error ? cause.message : '所属グループを読み込めませんでした。保存内容を保持しています。');
    }
    if (alive.current && current === revision.current) setSessionStarted(true);
  }, [showStartupDisplay]);
  useEffect(() => {
    if (!isSharingConfigured()) { setReady(true); return; }
    alive.current = true;
    void (async () => {
      try {
        const saved = await traceStartup('workspace.savedStartup', readSavedStartupDisplay).catch(() => undefined);
        if (saved && alive.current && revision.current === 0) {
          showStartupDisplay(saved); setGroup(saved.record); setUserId(saved.record.userId); setReady(true);
          await waitForInitialFrame(true);
        }
        // The saved display already rechecked this protected selection. The
        // session opened below still revalidates identity and current membership.
        const selected = saved?.record ?? await readSharingSelection();
        const enabled = selected || await hasSharingSessionEnabled();
        if (enabled && !selected && await traceStartup('workspace.personalStartup', canShowPersonalStartup)
          && alive.current && revision.current === 0) {
          setReady(true); await waitForInitialFrame();
        }
        if (enabled) await refreshSharing();
      }
      catch { if (alive.current) { showStartupDisplay(null); setError('所属グループの保存情報を読み込めませんでした。'); } }
      finally { if (alive.current) setReady(true); }
    })();
    const unsubscribe = subscribeSharingChanges(change => { if (!change?.statusOnly) void refreshSharing().catch(() => undefined); });
    return () => { alive.current = false; unsubscribe(); };
  }, [refreshSharing, showStartupDisplay]);
  useEffect(() => {
    if (!sessionStarted) return;
    let first = true;
    const last = authenticatedRevision.current;
    return observeSharingUser(user => {
      // Firebase immediately emits its initial state for a new observer.
      const alreadyHandled = first && last?.revision === revision.current && last.userId === (user?.uid ?? null);
      first = false;
      if (!alreadyHandled) void refreshSharing().catch(() => undefined);
    });
  }, [refreshSharing, sessionStarted]);
  const groupKey = JSON.stringify([group?.groupId, group?.status, group?.localGeneration,
    group?.rosterArchive?.at(-1)?.body.schedulerVersion]);
  useEffect(() => {
    if (!ready || !userId || !sessionStarted) return;
    let stopped = false; let generation = 0; let subscriptions: (() => void)[] = [];
    const stop = () => { generation++; subscriptions.forEach(unsubscribe => unsubscribe()); subscriptions = []; };
    const start = async () => {
      stop(); const current = generation;
      const live = () => !stopped && current === generation && AppState.currentState === 'active';
      if (active?.protocol === 2) {
        const attempt = displayGate.wait(active); subscriptions.push(attempt.cancel);
        if (!await attempt.promise || !live()) return;
      }
      const sharedRecovery = createDemandWorker({ active: live, run: async () => {
        const result = await syncSharingWorkspace(20_000, { restoreAccount: false });
        if (!live() || result.kind !== 'pending' || result.waitingForSignal) return false;
        return result.retryAt ? { retryAt: result.retryAt } : true;
      } });
      const privateRecovery = createDemandWorker({ active: live, run: async () => {
        const result = await syncKnownPrivateCalendar();
        return live() && result?.kind === 'waiting' && privateCalendarWaitRetry(result.retryAt);
      } });
      subscriptions.push(sharedRecovery.stop, privateRecovery.stop);
      try { subscriptions.push(startPrivateCalendarForeground(userId)); } catch { /* Private failure does not block the group. */ }
      try {
        const module = await import('@/platform/sharing/account-device-runtime');
        if (live()) {
          const update = () => { if (live()) setRestoration(module.accountDeviceRestoreStatus(userId)?.phase ?? null); };
          subscriptions.push(module.subscribeAccountDeviceRestoreStatus(update), module.startAccountDeviceForeground(userId)); update();
        }
      } catch { /* Account restoration retries independently of the existing group. */ }
      try {
        const record = await currentSharingWorkspace();
        if (!live()) return;
        if (record) {
          const workspace = await openSharedWorkspace(record); if (!live()) return;
          let listenerFailed = false; let unsubscribe = () => {};
          const attach = () => {
            unsubscribe();
            unsubscribe = workspace.watch(incoming.request, () => {
              listenerFailed = true; incoming.request(); sharedRecovery.request();
            });
          };
          const incoming = createDemandWorker({ active: live, run: async () => {
            try {
              const result = await workspace.sync();
              if (listenerFailed && live() && result.complete) { listenerFailed = false; attach(); }
              return !result.complete && !result.waitingForApproval || result.pending > 0;
            } catch { sharedRecovery.request(); return listenerFailed; }
          } });
          subscriptions.push(incoming.stop, () => unsubscribe()); attach();
        }
      } catch { /* The coordinator records and retries failures. */ }
      if (!live()) return;
      sharedRecovery.request(); privateRecovery.request();
    };
    if (AppState.currentState === 'active') void start().catch(() => undefined);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void start().catch(() => undefined); else stop();
    });
    return () => { stopped = true; stop(); subscription.remove(); };
  }, [active, displayGate, groupKey, ready, sessionStarted, userId]);
  const value = useMemo(() => ({ active, group, userId, ready, error, refreshSharing, completeInitialDisplay, startupDisplay, restoration: initialSyncPending ? 'waiting' as const : restoration }), [active, group, userId, ready, error, refreshSharing, completeInitialDisplay, startupDisplay, restoration, initialSyncPending]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function ActiveWorkspaceScope({ children }: { children: ReactNode }) {
  const context = useWorkspace();
  if (!context.ready) return <View style={{ flex: 1, backgroundColor: palette.background }} />;
  return children;
}
export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext); if (!context) throw new Error('WorkspaceProvider is required'); return context;
}
