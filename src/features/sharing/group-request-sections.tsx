import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, Text, View } from 'react-native';
import { palette, typography } from '../../components/planner-ui';
import { SettingsAction, SettingsGroup } from '../../components/settings-controls';
import { useWorkspace } from '@/hooks/use-workspace';
import { subscribeSharingChanges } from '@/platform/sharing/workspaces';
import type { V2SharedWorkspace } from '../../platform/sharing/workspace-types';
import { addDays } from '../../domain/scheduling/local-date';
import { sharedLocalDate } from './group-clock';
import { useOptionalWorkspaceDisplay } from '@/features/sharing/v2-ui/workspace-data';
import type { V2GroupUiSession } from './v2-ui/screen-session';
import { V2DateRequests } from './v2-ui/date-requests';
import { V2AssignmentRequests } from './v2-ui/assignment-requests';

type Loaded = { workspace: V2SharedWorkspace; session: V2GroupUiSession; model: Awaited<ReturnType<V2GroupUiSession['readModel']>> };

/** The request page shares one local read without starting synchronization. */
export function GroupRequestSections({ workspace, busy, run, compact = false }: { workspace: V2SharedWorkspace; busy: boolean; compact?: boolean;
  run: (work: () => Promise<void>) => Promise<boolean> }) {
  const context = useWorkspace(); const display = useOptionalWorkspaceDisplay();
  const [result, setLoaded] = useState<Loaded | null>(null); const [error, setError] = useState<string | null>(null);
  const loaded = result?.workspace === workspace && context.userId === workspace.userId ? result : null;
  const current = useRef({ workspace, owner: context.userId }); const reload = useRef<(() => Promise<void>) | null>(null);
  useLayoutEffect(() => { current.current = { workspace, owner: context.userId }; }, [workspace, context.userId]);
  const fallback = useMemo<V2GroupUiSession>(() => ({ controller: workspace.session.controller, groupId: workspace.groupId, userId: workspace.userId,
    readModel: () => workspace.session.controller.readModel(({ timeZone }) => {
      const today = sharedLocalDate(new Date(), timeZone); return { from: addDays(today, -14), through: addDays(today, 14), asOfDate: today };
    }),
    readOwnCalendar: async target => {
      if (target.precision !== 'interval') return { kind: 'unknown', reason: 'timeNotSpecified' };
      throw new Error('本人のカレンダーを確認できません。アカウントを確認して、もう一度開いてください。');
    },
  }), [workspace]);
  useFocusEffect(useCallback(() => {
    let stopped = false, again = false; let pending: Promise<void> | null = null;
    const live = () => !stopped && current.current.workspace === workspace && current.current.owner === workspace.userId;
    const read = (): Promise<void> => {
      if (!live()) return Promise.resolve();
      if (pending) { again = true; return pending; }
      const work = (async () => {
        try {
          do {
            again = false; await workspace.record(); if (!live()) return;
            const session = display?.workspace?.groupId === workspace.groupId && display.workspace.userId === workspace.userId ? await display.loadSession() : fallback;
            if (!live()) return;
            if (session.groupId !== workspace.groupId || session.userId !== workspace.userId) throw new Error('申請を表示するグループが変わりました。');
            // Requests use common authenticated state; personal scheduling and Google fetching are unnecessary here.
            const model = await session.readModel({ management: true });
            if (!live()) return;
            if (model.viewerUserId !== workspace.userId || model.plan.groupId !== workspace.groupId) throw new Error('申請を表示するアカウントが変わりました。');
            setLoaded({ workspace, session, model }); setError(null);
          } while (again && live());
        } catch (cause) { if (live()) setError(cause instanceof Error && /[ぁ-んァ-ヶ一-龯]/u.test(cause.message) ? cause.message : '申請を読み込めませんでした。'); }
      })();
      pending = work; void work.finally(() => { if (pending === work) pending = null; }); return work;
    };
    reload.current = read; void read();
    const stop = subscribeSharingChanges(scope => {
      if (scope?.statusOnly || scope && (scope.userId !== workspace.userId || scope.groupId !== workspace.groupId)) return;
      void read();
    });
    return () => { stopped = true; stop(); if (reload.current === read) reload.current = null; };
  }, [workspace, display, fallback]));
  const perform = async (work: () => Promise<unknown>) => {
    await run(async () => {
      if (current.current.workspace !== workspace || current.current.owner !== workspace.userId) throw new Error('申請を操作するアカウントが変わりました。');
      await workspace.record();
      if (current.current.workspace !== workspace || current.current.owner !== workspace.userId) throw new Error('申請を操作するアカウントが変わりました。');
      await work(); await reload.current?.();
    });
  };
  const status = error ? <View style={{ gap: 8 }}><Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text>
    <SettingsAction title="申請を再読込" placement="page" onPress={() => { void reload.current?.(); }} /></View> : null;
  const disabled = busy || Boolean(error) || context.userId !== workspace.userId;
  const dateRequests = loaded ? <V2DateRequests embedded model={loaded.model} actions={loaded.session.controller.actions} busy={disabled} run={perform} readOwnCalendar={loaded.session.readOwnCalendar} /> : null;
  const assignmentRequests = loaded ? <V2AssignmentRequests embedded model={loaded.model} actions={loaded.session.controller.actions} busy={disabled} run={perform} onResolve={id => {
    const round = loaded.model.plan.occurrences.find(value => value.id === id);
    if (!disabled && round?.subjects[0]) router.push({ pathname: '/group-v2/assignment', params: { occurrenceId: id, subjectId: round.subjects[0].id, anchorDate: round.anchorDate } });
  }} /> : null;
  if (compact) return <SettingsGroup title="日時・担当変更の申請">{status}
    {!loaded && !error ? <ActivityIndicator accessibilityLabel="変更の申請を確認中" color={palette.accent} /> : null}
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}><Text style={[typography.body, { color: palette.ink }]}>日時変更</Text>
      {loaded && !loaded.model.requests.length ? <Text style={[typography.caption, { color: palette.muted }]}>なし</Text> : null}</View>
    {loaded?.model.requests.length ? dateRequests : null}
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}><Text style={[typography.body, { color: palette.ink }]}>担当変更</Text>
      {loaded && !loaded.model.assignmentRequests.length ? <Text style={[typography.caption, { color: palette.muted }]}>なし</Text> : null}</View>
    {loaded?.model.assignmentRequests.length ? assignmentRequests : null}
  </SettingsGroup>;
  return <View>
    {status}
    {!loaded && !error ? <ActivityIndicator accessibilityLabel="変更の申請を確認中" color={palette.accent} /> : null}
    <SettingsGroup title="日時変更">
      {dateRequests}
    </SettingsGroup>
    <SettingsGroup title="担当変更">
      {assignmentRequests}
    </SettingsGroup>
  </View>;
}

