import { useCallback, useContext, useLayoutEffect, useRef } from 'react';
import { router } from 'expo-router';
import { WorkspaceContext } from '../../contexts/workspace-context';
import { V2ReminderScreen } from '../sharing/v2-ui/reminder-screen';

export function GeneralGroupNotifications() {
  const context = useContext(WorkspaceContext);
  const active = context?.active?.protocol === 2 && context.active.userId === context.userId ? context.active : null;
  const latest = useRef(active);
  useLayoutEffect(() => { latest.current = active; return () => { latest.current = null; }; }, [active]);
  const load = useCallback(async () => {
    const guard = () => { if (!active || latest.current !== active) throw new Error('共有グループの参加状態が変わりました。'); };
    guard(); const runtime = await active!.reminders(); guard();
    const checked = <A extends unknown[], R>(work: (...args: A) => Promise<R>) => async (...args: A) => {
      guard(); const value = await work(...args); guard(); return value;
    };
    return { ...runtime, store: { ...runtime.store, read: checked(runtime.store.read), save: checked(runtime.store.save) },
      requestPermission: checked(runtime.requestPermission), permissionStatus: checked(runtime.permissionStatus),
      synchronize: checked(runtime.synchronize), clear: checked(runtime.clear) };
  }, [active]);
  return active ? <V2ReminderScreen embedded key={`${active.userId}:${active.groupId}:${active.identity.deviceId}`}
    load={load} onBack={() => router.back()} /> : null;
}
