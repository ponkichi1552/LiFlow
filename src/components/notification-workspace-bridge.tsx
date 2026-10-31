import { useEffect, useRef } from 'react';
import { router } from 'expo-router';
import { addNotificationResponseReceivedListener, clearLastNotificationResponse, getLastNotificationResponse } from 'expo-notifications';
import type { NotificationResponse } from 'expo-notifications';
import { useWorkspace } from '@/hooks/use-workspace';
import { notificationWorkspace, isPlannerNotification } from '@/features/notifications/workspace-response';

/** Resolve after secure workspace restoration, including taps that cold-started the app. */
export function NotificationWorkspaceBridge() {
  const workspace = useWorkspace(); const latest = useRef(workspace);
  useEffect(() => { latest.current = workspace; }, [workspace]);
  const handled = useRef(new Set<string>()); const tail = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!workspace.ready) return;
    let live = true;
    const receive = (response: NotificationResponse | null) => {
      if (!response) return;
      const work = async () => {
        if (!live) return;
        const id = `${response.notification.request.identifier}:${response.actionIdentifier}`;
        if (handled.current.has(id)) return;
        const current = latest.current; const data = response.notification.request.content.data;
        const selection = notificationWorkspace(data, current.userId, current.group);
        if (!isPlannerNotification(data)) return;
        if (selection === undefined) router.replace('/sharing');
        else if (selection === null || selection.groupId === current.active?.groupId) { if (live) router.replace('/'); } else return;
        handled.current.add(id);
        const saved = getLastNotificationResponse();
        if (saved?.notification.request.identifier === response.notification.request.identifier && saved.actionIdentifier === response.actionIdentifier) clearLastNotificationResponse();
      };
      const next = tail.current.then(work, work); tail.current = next.catch(() => undefined);
    };
    const subscription = addNotificationResponseReceivedListener(receive);
    receive(getLastNotificationResponse());
    return () => { live = false; subscription.remove(); };
  }, [workspace.ready]);
  return null;
}
