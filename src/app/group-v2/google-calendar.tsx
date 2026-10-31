import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { PlannerLoadState } from '../../components/planner-load-state';
import { useWorkspace } from '../../hooks/use-workspace';
import { SharedGoogleCalendarSettings } from '../../features/calendar/shared-google-settings';
import type { SharedGoogleCalendarExport } from '../../features/calendar/shared-google-export';

export default function SharedGoogleCalendarRoute() {
  const { active } = useWorkspace(); const [runtime, setRuntime] = useState<{ group: typeof active; value: SharedGoogleCalendarExport } | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { let alive = true;
    if (active?.protocol === 2) void active.googleCalendar().then(value => { if (alive) setRuntime({ group: active, value }); }).catch(() => { if (alive) setError('Google接続を開けませんでした。'); });
    return () => { alive = false; };
  }, [active]);
  return runtime?.group === active && runtime ? <SharedGoogleCalendarSettings runtime={runtime.value} onBack={() => router.back()} />
    : <PlannerLoadState title="共有予定とGoogle" message={active ? '接続設定を読み込んでいます。' : '参加中のグループを確認してください。'} error={error} retry={async () => { router.replace('/sharing'); }} />;
}
