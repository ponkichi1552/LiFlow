import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { useWorkspace } from '../../../hooks/use-workspace';
import { usePlannerData } from '../../../hooks/use-planner-data';
import { createV2ScreenSession } from './screen-session';
import { v2OwnerScheduleSettings } from './owner-preferences';
import { subscribeSharingChanges } from '@/platform/sharing/workspaces';
import { createV2PrivateTaskSource } from './private-overlay';
import { readPersonalPlannerOverlaySnapshot, setPersonalDateTaskCompleted, mirrorSharedChoreCompletions } from '../../../platform/storage/repository';
import { syncGoogleTasksAfterLocalCompletion } from '@/features/google-sync/coordinator';
import { readLocalCalendar, subscribeLocalCalendar } from '../../../platform/storage/calendar-events';
import { createLocalCalendarPlanSource } from '../../calendar/private-availability';
import { createWorkspaceDisplayStore } from './workspace-display-store';
import type { WorkspaceDisplayValue } from './workspace-display-store';
import type { V2GroupUiSession } from './screen-session';
import { millisecondsUntilNextSharedDay } from '../group-clock';
import type { SharedWorkspace } from '../../../platform/sharing/workspaces';
import { createRestoringSessionGate, restoringDisplaySession } from '../../planner/restoring-session';
import { startupDisplayCache } from '../../../platform/sharing/startup-display';

interface WorkspaceDisplayBinding {
  workspace: Extract<SharedWorkspace, { protocol: 2 }> | null;
  invalidate: () => void;
  loadSession: () => Promise<V2GroupUiSession>;
  subscribe: (changed: () => void) => () => void;
  peek: (options?: Parameters<V2GroupUiSession['readModel']>[0]) => WorkspaceDisplayValue | undefined;
}
const WorkspaceDisplayContext = createContext<WorkspaceDisplayBinding | null>(null);

/** Prepares every main tab while the app is open, without waiting for its first navigation. */
export function WorkspaceDisplayProvider({ children }: { children: ReactNode }) {
  const context = useWorkspace();
  const { database: personalDatabase, snapshot: personalSnapshot, refresh: refreshPersonal } = usePlannerData({ personal: true });
  const active = context.active?.protocol === 2 ? context.active : null;
  const groupId = active?.groupId ?? context.startupDisplay?.record.groupId;
  const restoring = useMemo(() => ({ ...createRestoringSessionGate(), scope: { userId: context.userId, groupId } }), [context.userId, groupId]);
  const onInitialDisplay = context.completeInitialDisplay;
  const completeInitialDisplay = useCallback(() => { if (active) onInitialDisplay?.(active); }, [active, onInitialDisplay]);
  const current = useRef<{ active: typeof active; userId: string | null; database: typeof personalDatabase; settings: NonNullable<typeof personalSnapshot>['settings'] | undefined } | null>({ active, userId: context.userId, database: personalDatabase, settings: personalSnapshot?.settings });
  useLayoutEffect(() => {
    current.current = { active, userId: context.userId, database: personalDatabase, settings: personalSnapshot?.settings };
    return () => { current.current = null; };
  }, [active, context.userId, personalDatabase, personalSnapshot?.settings]);
  const assertWorkspaceAccess = useCallback(async () => {
    const matches = () => active && current.current?.active === active && current.current.userId === active.userId && current.current.database === personalDatabase;
    if (!matches()) throw new Error('個人家事を操作するアカウント・グループが変わりました。');
    await active!.record();
    if (!matches()) throw new Error('個人家事を操作するアカウント・グループが変わりました。');
  }, [active, personalDatabase]);
  const openCalendar = useCallback(async () => {
    await assertWorkspaceAccess();
    const { openPrivateCalendarRuntime } = await import('../../../platform/sharing/private-calendar-runtime');
    await assertWorkspaceAccess(); const calendar = openPrivateCalendarRuntime(active!.userId); await assertWorkspaceAccess(); return calendar;
  }, [active, assertWorkspaceAccess]);
  const subscribeInputs = useCallback((changed: () => void) => {
    let stopped = false; let stopCalendar: (() => void) | undefined;
    const matches = () => !stopped && active && current.current?.active === active && current.current.userId === active.userId;
    const stopSharing = subscribeSharingChanges((scope) => {
      if (matches() && !scope?.statusOnly && scope?.userId === active!.userId && scope.groupId === active!.groupId) changed();
    });
    const stopLocalCalendar = personalDatabase ? subscribeLocalCalendar(personalDatabase, change => {
      if (matches() && change !== 'drafts' && change !== 'categories') changed();
    }) : undefined;
    void openCalendar().then(calendar => { if (matches()) stopCalendar = calendar.subscribe(() => { if (matches()) changed(); }); }).catch(() => {});
    return () => { stopped = true; stopSharing(); stopCalendar?.(); stopLocalCalendar?.(); };
  }, [active, openCalendar, personalDatabase]);
  const retainedSession = useRef<{ active: typeof active; database: typeof personalDatabase; session: V2GroupUiSession } | null>(null);
  const loadSource = useCallback(async () => {
    if (!active || context.userId !== active.userId) throw new Error('所属グループを確認してください。');
    await assertWorkspaceAccess();
    if (retainedSession.current?.active === active && retainedSession.current.database === personalDatabase) return retainedSession.current.session;
    const assertPersonalAccess = assertWorkspaceAccess;
    const privateTasks = createV2PrivateTaskSource({ ownerUserId: active.userId, assertAccess: assertPersonalAccess,
      mirrorShared: (source, guard) => mirrorSharedChoreCompletions(personalDatabase, source, guard),
      readSnapshot: async (instant) => ({ ...await readPersonalPlannerOverlaySnapshot(personalDatabase, instant), ownerUserId: active.userId }),
      save: (command, guard) => setPersonalDateTaskCompleted(personalDatabase, command, guard),
      afterChange: async () => {
        await assertPersonalAccess(); syncGoogleTasksAfterLocalCompletion(personalDatabase);
        try { await refreshPersonal({ force: true }); }
        catch { throw new Error('個人家事は保存済みです。表示を更新するため再読込してください。'); }
      } });
    const session = createV2ScreenSession({ groupId: active.groupId, userId: active.userId, now: () => new Date(),
      privateTasks,
      calendar: {
        readForPlan: async () => { const calendar = await openCalendar(); const value = await calendar.readForPlan(); await assertWorkspaceAccess(); return value; },
        readOwnCalendar: async target => { const calendar = await openCalendar(); const value = await calendar.readOwnCalendar(target); await assertWorkspaceAccess(); return value; },
      },
      localCalendar: createLocalCalendarPlanSource({ ownerUserId: active.userId, assertAccess: assertWorkspaceAccess, read: () => readLocalCalendar(personalDatabase) }),
      controller: { ...active.session.controller, sync: () => active.sync({ force: true }) },
      readPreferences: async () => {
        await active.record();
        const calendar = await openCalendar(); const own = await calendar.readPlannerPreferences?.(); await assertWorkspaceAccess();
        return v2OwnerScheduleSettings(active.userId, current.current?.settings, own);
      } });
    retainedSession.current = { active, database: personalDatabase, session }; return session;
  }, [active, context.userId, personalDatabase, refreshPersonal, assertWorkspaceAccess, openCalendar]);
  const prepared = useMemo(() => ({ load: loadSource, store: createWorkspaceDisplayStore() }), [loadSource]);
  const store = prepared.store;
  useLayoutEffect(() => { store.bind(prepared.load); }, [store, prepared]);
  useLayoutEffect(() => {
    if (active) restoring.bind(async () => { const value = await store.read(); return value.session; });
    else if (context.error) restoring.fail(new Error(context.error));
  }, [active, context.error, restoring, store]);
  useEffect(() => () => restoring.close(), [restoring]);
  const savedDisplay = useMemo<WorkspaceDisplayValue | undefined>(() => context.startupDisplay ? {
    model: context.startupDisplay.model, session: restoringDisplaySession(context.startupDisplay.model, restoring.get),
  } : undefined, [context.startupDisplay, restoring]);
  const binding = useMemo<WorkspaceDisplayBinding>(() => ({
    workspace: active, invalidate: store.invalidate,
    // The calendar already marks dates outside its verified range as unloaded.
    // A cold calendar entry can show the saved range while wider data restores.
    peek: options => store.peek(options) ?? (!options?.management && !options?.focusDate
      && (!options?.calendarMonth || options.calendarMonth === 'current') ? savedDisplay : undefined),
    subscribe: store.subscribe,
    loadSession: async () => {
      if (!active) return restoring.get();
      const source = await loadSource();
      return { ...source, invalidate: store.invalidate, readModel: async options => {
        try { return (await store.read(options)).model; }
        finally { completeInitialDisplay(); }
      } };
    },
  }), [store, loadSource, active, completeInitialDisplay, savedDisplay, restoring]);
  const snapshotRef = useRef(personalSnapshot);
  useEffect(() => {
    if (snapshotRef.current === personalSnapshot) return;
    snapshotRef.current = personalSnapshot; store.invalidate();
  }, [personalSnapshot, store]);
  useEffect(() => {
    if (!context.ready || !active || active.userId !== context.userId || !personalSnapshot) return;
    let preparation = 0;
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined; let midnight: ReturnType<typeof setTimeout> | undefined;
    let idle: ReturnType<typeof requestIdleCallback> | undefined; let fallback: ReturnType<typeof setTimeout> | undefined;
    const cancelPreparation = () => { if (idle !== undefined) cancelIdleCallback(idle); idle = undefined; clearTimeout(fallback); };
    const prepare = () => {
      const revision = ++preparation;
      clearTimeout(timer); cancelPreparation();
      timer = setTimeout(() => {
        if (stopped || revision !== preparation || AppState.currentState !== 'active') return;
        // Publish the small overview first. Calendar and editing documents warm up
        // during idle time, after the initial screen can render and accept input.
        void store.read().then(value => {
          if (stopped || revision !== preparation) return;
          const zones = [value.model.plan.timeZone, ...(value.model.privateOverlay?.status === 'ready' ? [value.model.privateOverlay.timeZone] : [])];
          clearTimeout(midnight); midnight = setTimeout(changed, Math.min(...zones.map(zone => millisecondsUntilNextSharedDay(new Date(), zone))) + 50);
          const warm = () => {
            if (stopped || revision !== preparation || AppState.currentState !== 'active') return;
            idle = undefined;
            // Persist only a verified result, encrypted separately from the live
            // database. A cache never supplies authority or a writable session.
            void active.record().then(record => startupDisplayCache.write(record, value.model)).catch(() => undefined);
            void store.read({ calendarMonth: 'current' }).then(() => {
              if (!stopped && revision === preparation && AppState.currentState === 'active') return store.read({ management: true, choreSettings: true });
            }).catch(() => undefined);
          };
          if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(warm);
          else fallback = setTimeout(warm, 0);
        }).catch(() => undefined).finally(completeInitialDisplay);
      }, 80);
    };
    const changed = () => { store.invalidate(); prepare(); };
    const unsubscribe = subscribeInputs(changed);
    const appState = AppState.addEventListener('change', state => { if (state === 'active') changed(); else { preparation++; clearTimeout(timer); clearTimeout(midnight); cancelPreparation(); } });
    prepare();
    return () => { stopped = true; preparation++; clearTimeout(timer); clearTimeout(midnight); cancelPreparation(); unsubscribe(); appState.remove(); };
  }, [active, context.ready, context.userId, personalSnapshot, store, subscribeInputs, completeInitialDisplay]);
  useEffect(() => () => store.dispose(), [store]);
  return <WorkspaceDisplayContext.Provider value={binding}>{children}</WorkspaceDisplayContext.Provider>;
}
export function useWorkspaceDisplay() {
  const binding = useContext(WorkspaceDisplayContext);
  if (!binding) throw new Error('WorkspaceDisplayProvider is required');
  return binding;
}
export function useOptionalWorkspaceDisplay() { return useContext(WorkspaceDisplayContext); }
