import { SharedCalendarConflicts } from './calendar-conflicts';
import { useGroupCalendar } from './use-group-calendar';
import type { V2MutationOutcome } from './mutation-outcome';
import { orderTaskRows } from './task-order';
import { createV2RoundVisibility } from './round-visibility';
import type { CompletionFeedback } from './completion-feedback';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useMemo, type ReactElement } from 'react';
import { addDays } from '../../../domain/scheduling/local-date';
import { Text, View } from 'react-native';
import { AppButton, Card, palette, typography } from '../../../components/planner-ui';
import type { LocalDate } from '../../../domain/shared/types';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2PersonalPlan } from '../v2/personal-plan';
import { v2CalendarMonth, v2CalendarProjection } from './calendar-projection';
import { V2RoundCard } from './round-card';
import { privateOverlayForViewer, privateOverlayPendingCounts, privateOverlayCalendarRows } from './private-overlay';
import type { V2PrivateOverlayState, V2PrivateTaskSource } from './private-overlay';
import { V2PrivateTaskCard, V2PrivateTaskNotice } from './private-task-card';
import { V2WasteOccurrence } from './waste-occurrence';
import { PlannerCalendar } from '../../calendar/planner-calendar';
import type { CalendarDayInfo, PlannerCalendarProps } from '../../calendar/planner-calendar';
import type { LocalCalendarBinding } from '../../calendar/use-local-calendar';

export function V2Calendar({ model, personal, privateOverlay: privateValue, privateSource, selectedDate, busy, actions, run, onMonth, onSelectDate, onRound, header, feedback, local: personalLocal, onNavigate, perform, workspaceName, onGuide }: {
  perform?: (work: () => Promise<unknown>) => Promise<V2MutationOutcome>; onGuide?: (choreId: string, source: 'shared' | 'personal') => void; feedback?: CompletionFeedback; local?: LocalCalendarBinding; onNavigate?: PlannerCalendarProps['onNavigate']; workspaceName?: string;
  model: V2GroupScreenModel; personal?: V2PersonalPlan; month: LocalDate; selectedDate: LocalDate; busy: boolean;
  actions: V2GroupController['actions']; run: (work: () => Promise<unknown>) => Promise<void>;
  onMonth: (month: LocalDate) => void; onSelectDate: (date: LocalDate) => void;
  onRound: (occurrenceId: string, subjectId: string, anchorDate: LocalDate) => void; header?: ReactElement;
  privateOverlay?: V2PrivateOverlayState; privateSource?: V2PrivateTaskSource;
}) {
  const local = useGroupCalendar(personalLocal, model, actions, perform, workspaceName ?? '共有グループ');
  // Feedback is tiny. Snapshot its contents so a cleared/reused map cannot leave
  // cached counts behind after an optimistic completion is rolled back.
  const completionRevision = JSON.stringify([...(feedback?.values ?? [])]);
  const completionValues = useMemo(() => new Map<string, boolean>(JSON.parse(completionRevision)), [completionRevision]);
  const projection = useMemo(() => v2CalendarProjection(model, personal, completionValues, true), [model, personal, completionValues]);
  const privateOverlay = privateOverlayForViewer(privateValue, model.viewerUserId);
  const privateCounts = useMemo(() => privateOverlayPendingCounts(privateOverlay?.status === 'ready' ? privateOverlay : undefined, completionValues, true), [privateOverlay, completionValues]);
  const privateReady = (date: LocalDate) => privateOverlay?.status === 'ready' && privateOverlay.range.from <= date && privateOverlay.range.through >= date;
  const loaded = (date: LocalDate) => model.plan.initialized && model.plan.range.from <= date && model.plan.range.through >= date;
  const wasteLoaded = (date: LocalDate) => model.waste && model.waste.range.from <= date && model.waste.range.through >= date;
  const visible = useMemo(() => createV2RoundVisibility(model), [model]);
  const chores = useMemo(() => new Map(model.plan.chores.map(chore => [chore.id, chore])), [model.plan.chores]);
  const dayInfo = useMemo(() => {
    const sharedReady = (date: LocalDate) => model.plan.initialized && model.plan.range.from <= date && date <= model.plan.range.through;
    const personalReady = (date: LocalDate) => privateOverlay?.status === 'ready' && privateOverlay.range.from <= date && date <= privateOverlay.range.through;
    const calculate = (date: LocalDate): CalendarDayInfo => {
      const shared = sharedReady(date) ? projection.byDate.get(date) ?? [] : [];
      const privateRows = personalReady(date) && privateOverlay?.status === 'ready' ? privateOverlayCalendarRows(privateOverlay.byDate.get(date) ?? [], date) : [];
      return { loaded: sharedReady(date), partial: Boolean(privateValue && !personalReady(date)), pending: (sharedReady(date) ? projection.counts.get(date) ?? 0 : 0) + (personalReady(date) ? privateCounts.get(date) ?? 0 : 0),
        accessibilityCountLabel: `${sharedReady(date) ? `確認できる未完了の共有家事${projection.counts.get(date) ?? 0}件` : '予定は未取得'}${privateValue ? personalReady(date) ? `、個人家事${privateCounts.get(date) ?? 0}件` : '、個人家事は未取得' : ''}`,
        total: shared.length + privateRows.length,
        minutes: shared.filter(entry => entry.counted).reduce((sum, entry) => sum + (chores.get(entry.round.choreId)?.estimatedMinutes ?? 0), 0)
          + privateRows.filter(row => !(completionValues?.get(row.key) ?? row.completed)).reduce((sum, row) => sum + (row.chore.estimatedMinutes ?? 0), 0) };
    };
    const summaries = new Map<LocalDate, CalendarDayInfo>();
    for (let day = model.plan.range.from; day <= model.plan.range.through; day = addDays(day, 1)) summaries.set(day, calculate(day));
    if (privateOverlay?.status === 'ready') for (const day of privateOverlay.byDate.keys()) if (!summaries.has(day)) summaries.set(day, calculate(day));
    return (date: LocalDate) => summaries.get(date) ?? calculate(date);
  }, [model.plan.initialized, model.plan.range, projection, privateValue, privateOverlay, privateCounts, chores, completionValues]);
  const existingChores = useMemo(() => {
    const names = new Set<string>();
    return model.plan.occurrences.flatMap(round => round.subjects.filter(subject => subject.required).flatMap(subject => {
      const chore = chores.get(round.choreId); const name = chore?.name ?? '共有家事';
      if (names.has(name)) return []; names.add(name);
      return [{ id: subject.id, name, minutes: chore?.estimatedMinutes, round }];
    }));
  }, [model.plan.occurrences, chores]);
  const entriesFor = (date: LocalDate) => orderTaskRows([
    ...(loaded(date) ? projection.byDate.get(date) ?? [] : []).map(entry => ({ source: 'shared' as const, key: `shared:${entry.id}`, entry })),
    ...(privateReady(date) && privateOverlay?.status === 'ready' ? privateOverlayCalendarRows(privateOverlay.byDate.get(date) ?? [], date) : []).map(row => ({ source: 'personal' as const, key: row.key, row })),
  ], model.plan.range.asOfDate, item => item.source === 'personal'
    ? { completed: feedback?.values.get(item.key) ?? item.row.completed, load: item.row.chore.load, recommendedDate: item.row.suggestedDate, windowEnd: item.row.windowEnd, asOfDate: privateOverlay?.status === 'ready' ? privateOverlay.today : undefined }
    : { completed: visible(item.entry.round, item.entry.subject).showStatus && (feedback?.values.get(item.key) ?? item.entry.subject.completed),
      load: chores.get(item.entry.round.choreId)?.load ?? 'light', recommendedDate: item.entry.recommendation?.date ?? item.entry.subject.suggestedDate, windowEnd: item.entry.subject.executionWindowEnd });
  const caption = { ...typography.caption, color: palette.muted };
  return <PlannerCalendar today={model.plan.range.asOfDate} timeZone={model.plan.timeZone} selectedDate={selectedDate} local={local} busy={busy} workspaceName={workspaceName}
    repeatReturnTo="group" onSelectDate={onSelectDate} onMonth={onMonth} monthLoaded={target => { const grid = v2CalendarMonth(target); return loaded(grid.from) && loaded(grid.through) && Boolean(wasteLoaded(grid.from) && wasteLoaded(grid.through))
      && (privateOverlay?.status !== 'ready' || Boolean(privateReady(grid.from) && privateReady(grid.through))); }}
    onNavigate={onNavigate}
    notice={<View>{header}<SharedCalendarConflicts model={model} actions={actions} busy={busy} run={run} /></View>}
    wasteSchedules={model.waste?.schedules} hiddenWasteKeys={model.waste?.hiddenKeys}
    dayInfo={dayInfo}
    existingChores={existingChores.map(({ round, ...chore }) => ({ ...chore,
      onOpen: () => onGuide ? onGuide(round.choreId, 'shared') : onRound(round.id, chore.id, round.anchorDate) }))}
    renderWaste={date => <View style={{ paddingHorizontal: 6, gap: 4 }}>{wasteLoaded(date) ? model.waste!.occurrences.filter(entry => entry.occurrence.date === date).map(entry => <V2WasteOccurrence key={entry.key} entry={entry} compact busy={busy} actions={actions} run={run} />)
      : <Text style={caption}>この日の共有収集日は未取得です。</Text>}</View>}
    renderChores={date => <Animated.FlatList testID="calendar-chore-list" data={entriesFor(date)} scrollEnabled={false} itemLayoutAnimation={LinearTransition.duration(240)} keyExtractor={entry => entry.key} initialNumToRender={8}
      ListHeaderComponent={<View style={{ gap: 6 }}>
        <V2PrivateTaskNotice overlay={privateOverlay} sharedTimeZone={model.plan.timeZone} date={date} />
        {privateValue && !privateReady(date) ? <Text style={caption}>この月の個人家事は未取得です。月を再読込してください。</Text> : null}
        {!loaded(date) ? <><Text style={caption}>{busy ? '共有予定を読み込んでいます…' : 'この月の共有予定を取得できていません。'}</Text><AppButton title="この月を再読込" variant="quiet" compact disabled={busy} onPress={() => onMonth(v2CalendarMonth(date).month)} /></> : null}
        {model.waste?.rows.some(row => !row.deleted && row.needsReview) ? <Text style={caption}>確認が必要な収集ルールは共有のゴミ収集日で確認できます。</Text> : null}
      </View>}
      ListEmptyComponent={loaded(date) && !busy ? <Card><Text style={caption}>この日の共有家事はありません。</Text></Card> : undefined}
      renderItem={({ item }) => item.source === 'personal' ? <V2PrivateTaskCard compact row={item.row} today={privateOverlay?.status === 'ready' ? privateOverlay.today : undefined} source={privateSource} busy={busy} run={run} feedback={feedback} mixedSources
        onOpen={onGuide ? () => onGuide(item.row.chore.id, 'personal') : undefined} />
        : <V2RoundCard compact model={model} round={item.entry.round} subject={item.entry.subject} recommendation={item.entry.recommendation} actions={actions} busy={busy} run={run} feedback={feedback}
          onOpen={() => onGuide ? onGuide(item.entry.round.choreId, 'shared') : onRound(item.entry.round.id, item.entry.subject.id, item.entry.round.anchorDate)} />} />}
  />;
}
