import { useCallback, useLayoutEffect, useRef } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { AppButton, Card, Page, typography } from '../../components/planner-ui';
import { useWorkspace } from '../../hooks/use-workspace';
import { V2ReminderScreen } from '../../features/sharing/v2-ui/reminder-screen';

export default function GroupNotificationsRoute() {
  const context = useWorkspace(); const router = useRouter(); const active = context.active?.protocol === 2 ? context.active : null;
  const latest = useRef(active); useLayoutEffect(() => { latest.current = active; return () => { latest.current = null; }; }, [active]);
  const load = useCallback(async () => {
    if (!active || latest.current !== active) throw new Error('共有グループを選び直してください。');
    const runtime = await active.reminders();
    const guard = () => { if (latest.current !== active) throw new Error('共有グループの参加状態が変わりました。'); }; guard();
    return { ...runtime, store: { ...runtime.store,
      read: async () => { guard(); const value = await runtime.store.read(); guard(); return value; },
      save: async (...args: Parameters<typeof runtime.store.save>) => { guard(); const value = await runtime.store.save(...args); guard(); return value; } } };
  }, [active]);
  if (!context.ready || !active || active.userId !== context.userId) return <Page><Card><Text style={typography.body}>通知を設定する共有グループを開いてください。</Text>
    <AppButton title="共有グループへ" onPress={() => router.replace('/sharing')} /></Card></Page>;
  return <V2ReminderScreen key={`${active.userId}:${active.groupId}:${active.identity.deviceId}`} load={load} onBack={() => router.canGoBack() ? router.back() : router.replace('/group-v2')} />;
}
