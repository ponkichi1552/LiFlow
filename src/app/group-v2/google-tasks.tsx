import { useCallback, useLayoutEffect, useRef } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { AppButton, Card, Page, typography } from '../../components/planner-ui';
import { useWorkspace } from '../../hooks/use-workspace';
import { V2GoogleTasksScreen } from '../../features/sharing/v2-ui/google-tasks-screen';
import type { V2GoogleTaskUiRuntime } from '../../features/sharing/v2-ui/google-tasks-screen';

export default function GroupGoogleTasksRoute() {
  const context = useWorkspace(); const router = useRouter(); const active = context.active?.protocol === 2 ? context.active : null;
  const latest = useRef(active); useLayoutEffect(() => { latest.current = active; return () => { latest.current = null; }; }, [active]);
  const load = useCallback(async (): Promise<V2GoogleTaskUiRuntime> => {
    const guard = () => { if (!active || latest.current !== active) throw new Error('共有グループの参加状態が変わりました。'); }; guard();
    const runtime = await active!.googleTasks(); guard();
    const wrap = <Args extends unknown[], Value>(work: (...args: Args) => Promise<Value>) => async (...args: Args) => { guard(); const value = await work(...args); guard(); return value; };
    return { readControl: wrap(runtime.readControl), reviewConnection: wrap(runtime.reviewConnection), connect: wrap(runtime.connect), pause: wrap(runtime.pause), synchronize: wrap(runtime.synchronize) };
  }, [active]);
  if (!context.ready || !active || active.userId !== context.userId) return <Page><Card><Text style={typography.body}>Google連携を設定する共有グループを開いてください。</Text>
    <AppButton title="共有グループへ" onPress={() => router.replace('/sharing')} /></Card></Page>;
  return <V2GoogleTasksScreen key={`${active.userId}:${active.groupId}:${active.identity.deviceId}`} load={load} onBack={() => router.canGoBack() ? router.back() : router.replace('/group-v2')} />;
}
