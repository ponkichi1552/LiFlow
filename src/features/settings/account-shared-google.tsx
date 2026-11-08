import { SettingsAction } from '../../components/settings-controls';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { palette, typography } from '../../components/planner-ui';
import { V2GoogleTasksScreen, type V2GoogleTaskUiRuntime } from '../sharing/v2-ui/google-tasks-screen';
import { SharedGoogleCalendarSettings } from '../calendar/shared-google-settings';
import type { SharedGoogleCalendarExport } from '../calendar/shared-google-export';

export function AccountSharedGoogleTasks() {
  const context = useContext(WorkspaceContext);
  const active = context?.active?.protocol === 2 && context.active.userId === context.userId ? context.active : null;
  const latest = useRef(active); useLayoutEffect(() => { latest.current = active; return () => { latest.current = null; }; }, [active]);
  const load = useCallback(async (): Promise<V2GoogleTaskUiRuntime> => {
    const guard = () => { if (!active || latest.current !== active) throw new Error('共有グループの参加状態が変わりました。'); }; guard();
    const runtime = await active!.googleTasks(); guard();
    const wrap = <Args extends unknown[], Value>(work: (...args: Args) => Promise<Value>) => async (...args: Args) => { guard(); const value = await work(...args); guard(); return value; };
    return { readControl: wrap(runtime.readControl), reviewConnection: wrap(runtime.reviewConnection), connect: wrap(runtime.connect), pause: wrap(runtime.pause), synchronize: wrap(runtime.synchronize) };
  }, [active]);
  return active ? <V2GoogleTasksScreen embedded key={`${active.userId}:${active.groupId}:${active.identity.deviceId}`} load={load} onBack={() => {}} /> : null;
}

export function AccountSharedGoogleCalendar() {
  const context = useContext(WorkspaceContext); const active = context?.active?.protocol === 2 && context.active.userId === context.userId ? context.active : null;
  const [result, setResult] = useState<{ group: typeof active; runtime: SharedGoogleCalendarExport } | null>(null);
  const [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => { let current = true;
    if (active) void active.googleCalendar().then(runtime => { if (current) setResult({ group: active, runtime }); }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [active, attempt]);
  if (!active) return null;
  return result?.group === active ? <SharedGoogleCalendarSettings embedded runtime={result.runtime} onBack={() => {}} />
    : <View style={{ gap: 8 }}>{error ? <><Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>共有予定の接続設定を読み込めませんでした。</Text>
      <SettingsAction placement="panel" title="共有予定の連携を再読込" compact onPress={() => { setError(false); setAttempt(value => value + 1); }} /></> : <ActivityIndicator accessibilityLabel="共有予定の接続設定を確認中" color={palette.accent} />}</View>;
}
