import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { AppButton, Card, palette, typography } from '@/components/planner-ui';
import { PlannerLoadState } from '@/components/planner-load-state';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { WasteOccurrenceCard } from '@/components/waste-occurrence-card';
import { CompletionToast } from '@/components/home-ui';
import { completionPeriod } from '@/domain/scheduling/completion-matching';
import type { DateTask } from '@/domain/scheduling/date-tasks';
import { addDays, formatJapaneseDate, localDateFromDate } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import { useTaskCompletion } from '@/hooks/use-task-completion';
import { isTaskUrgent } from '@/domain/scheduling/task-priority';
import { generateWasteCollectionDates } from '@/features/waste/weekly-scheduler';
import { useWasteOccurrenceToggle } from '@/features/waste/use-waste-occurrence-toggle';
import { PlannerCalendar } from '@/features/calendar/planner-calendar';
import { useLocalCalendar } from '@/features/calendar/use-local-calendar';
import { personalCalendarTasks } from '@/features/calendar/personal-projection';

export default function CalendarScreen() {
  const { snapshot, loading, error, refresh, database, readError } = usePlannerData();
  const local = useLocalCalendar(database);
  const today = snapshot?.today ?? localDateFromDate(new Date());
  const [selectedDate, setSelectedDate] = useState<LocalDate>(today); const [periodDate, setPeriodDate] = useState<LocalDate | null>(null);
  const completion = useTaskCompletion(database, refresh, readError); const waste = useWasteOccurrenceToggle(database, refresh);
  const tasksFor = snapshot ? personalCalendarTasks(snapshot, today, completion.project) : () => [] as DateTask[];
  if (loading || !snapshot) return <PlannerLoadState title="カレンダー" message="予定を読み込んでいます。" error={error} retry={refresh} />;
  const chores = new Map(snapshot.chores.map(chore => [chore.id, chore])); const hidden = new Set(snapshot.hiddenWasteOccurrenceKeys);
  const counts = completion.calendarCounts(snapshot.scheduleEntries, snapshot.completions);
  const navigate = (tab: 'home' | 'calendar' | 'chores' | 'appliances') => router.navigate(({ home: '/(tabs)', calendar: '/(tabs)/explore', chores: '/(tabs)/guide', appliances: '/(tabs)/manual' } as const)[tab]);
  const open = (choreId: string) => router.navigate({ pathname: '/(tabs)/guide', params: { choreId, returnTo: 'calendar' } });
  const renderTask = (task: DateTask, date: LocalDate) => {
    const chore = chores.get(task.choreId); if (!chore) return null;
    return <Animated.View key={`${chore.id}:${date}`} layout={LinearTransition.duration(240)}><TaskCheckboxRow chore={chore} completed={task.completed} source="personal" early={date < task.suggestedDate}
      urgent={isTaskUrgent({ completed: task.completed, load: chore.load, recommendedDate: task.suggestedDate, windowEnd: task.entry?.windowEnd ?? task.completion?.scheduledWindowEnd }, today)}
      onOpen={() => open(chore.id)} onToggle={completion.canToggle(task) ? () => void completion.toggle(task) : undefined} /></Animated.View>;
  };
  return <SafeAreaView edges={['top']} style={styles.safe}>
    <PlannerCalendar today={today} timeZone={snapshot.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} selectedDate={selectedDate} onSelectDate={setSelectedDate} local={local}
      busy={completion.pending.size > 0} onNavigate={navigate} countColors={snapshot.settings.calendarCountColors} countMode={snapshot.settings.calendarCountDisplayMode}
      wasteSchedules={snapshot.wasteSchedules} hiddenWasteKeys={snapshot.hiddenWasteOccurrenceKeys}
      dayInfo={date => ({ loaded: date <= addDays(today, 180), pending: counts.get(date) ?? 0, total: tasksFor(date).length,
        minutes: tasksFor(date).filter(task => !task.completed).reduce((sum, task) => sum + (chores.get(task.choreId)?.estimatedMinutes ?? 0), 0) })}
      existingChores={snapshot.chores.filter(chore => chore.enabled && !chore.archived).map(chore => ({ id: chore.id, name: chore.name, minutes: chore.estimatedMinutes, onOpen: () => open(chore.id) }))}
      notice={error || completion.error || waste.error ? <View style={styles.notice}><Text accessibilityRole="alert" style={styles.error}>{waste.error ?? completion.error ?? error}</Text><AppButton title="表示を再読込" variant="quiet" compact disabled={completion.pending.size > 0 || completion.reading} onPress={() => void completion.retryRead()} /></View> : null}
      renderWaste={date => <View style={styles.waste}>{snapshot.wasteSchedules.flatMap(schedule => generateWasteCollectionDates(schedule, date, date)).map(item => {
        const key = `${item.scheduleId}:${item.date}`; return <WasteOccurrenceCard key={key} occurrence={item} compact hidden={hidden.has(key)} busy={waste.busyKeys.has(key)} onToggle={() => void waste.toggle(item, hidden.has(key))} />;
      })}</View>}
      renderChores={date => {
        const tasks = tasksFor(date); const ids = new Set(tasks.map(task => task.choreId));
        const overdue = date === today ? [] : tasksFor(today).filter(task => task.entry?.status === 'overdue' && !task.completed && !ids.has(task.choreId));
        return <View style={styles.tasks}>{tasks.length ? tasks.map(task => renderTask(task, date)) : <Text style={styles.caption}>{date > addDays(today, 180) ? 'この日の家事はまだ計算されていません。' : 'この日の家事はありません。'}</Text>}
          {overdue.length ? <><Text style={styles.section}>期間を過ぎた家事</Text>{overdue.slice(0, 3).map(task => renderTask(task, today))}</> : null}
          {tasks.length ? <AppButton title={periodDate === date ? '実施期間を閉じる' : '実施期間を確認'} compact variant="quiet" onPress={() => setPeriodDate(before => before === date ? null : date)} /> : null}
          {periodDate === date ? <Card><Text style={styles.section}>{formatJapaneseDate(date)}を含む実施期間</Text>{tasks.map(task => {
            const period = task.entry ? { start: task.entry.windowStart, end: task.entry.windowEnd } : completionPeriod(task.completion!);
            return <View key={task.choreId} style={styles.period}><Text style={styles.caption}>{chores.get(task.choreId)?.name}</Text><Text style={styles.caption}>{formatJapaneseDate(period.start)}〜{formatJapaneseDate(period.end)}</Text></View>;
          })}</Card> : null}
        </View>;
      }} />
    {completion.undoAvailable ? <View style={styles.toast}><CompletionToast busy={completion.pending.size > 0} onUndo={() => void completion.undoLast()} /></View> : null}
  </SafeAreaView>;
}
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: palette.background }, notice: { padding: 10, gap: 6 }, error: { ...typography.caption, color: palette.warning },
  caption: { ...typography.caption, color: palette.muted }, section: { ...typography.label, color: palette.ink, fontWeight: '700' }, tasks: { gap: 4 }, waste: { paddingHorizontal: 6, gap: 4 }, period: { gap: 2, paddingVertical: 4 },
  toast: { position: 'absolute', bottom: 8, left: 0, right: 0 },
});
