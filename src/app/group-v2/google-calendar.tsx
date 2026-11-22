import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { PlannerLoadState } from '../../components/planner-load-state';
import { useWorkspace } from '../../hooks/use-workspace';
import { SharedGoogleCalendarSettings } from '../../features/calendar/shared-google-settings';
import type { SharedGoogleCalendarExport } from '../../features/calendar/shared-google-export';
import { backOrReplace } from '../../features/settings/settings-back';

export default function SharedGoogleCalendarRoute() {
  const { active, userId } = useWorkspace();
  const group = active?.protocol === 2 && active.userId === userId ? active : null;
  const [state, setState] = useState<{ group: NonNullable<typeof group>; runtime?: SharedGoogleCalendarExport; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!group) return;
    let alive = true;
    void group.googleCalendar().then(runtime => { if (alive) setState({ group, runtime }); }).catch(() => {
      if (alive) setState({ group, error: 'Google接続を開けませんでした。' });
    });
    return () => { alive = false; };
  }, [group, attempt]);
  const current = state?.group === group ? state : undefined;
  const back = () => backOrReplace(router, group ? '/group-v2' : '/sharing');
  return current?.runtime ? <SharedGoogleCalendarSettings runtime={current.runtime} onBack={back} />
    : <PlannerLoadState title="共有予定とGoogle" message={group ? '接続設定を読み込んでいます。' : '参加中のグループを確認してください。'}
      error={current?.error ?? null} retry={async () => { setState(undefined); setAttempt(value => value + 1); }} onBack={back} />;
}
