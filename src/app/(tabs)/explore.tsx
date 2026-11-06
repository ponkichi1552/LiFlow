import { router } from 'expo-router';
import { WorkspaceTab } from '@/components/workspace-tab';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { AppButton, palette, typography } from '@/components/planner-ui';
import { PlannerLoadState } from '@/components/planner-load-state';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { WasteOccurrenceCard } from '@/components/waste-occurrence-card';
import { CompletionToast } from '@/components/home-ui';
import type { DateTask } from '@/domain/scheduling/date-tasks';
import { addDays, localDateFromDate } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import { useTaskCompletion } from '@/hooks/use-task-completion';
import { generateWasteCollectionDates } from '@/features/waste/weekly-scheduler';
import { PlannerCalendar } from '@/features/calendar/planner-calendar';
import { useLocalCalendar } from '@/features/calendar/use-local-calendar';
import { personalCalendarTasks } from '@/features/calendar/personal-projection';

export default function CalendarScreen() {
  return <WorkspaceTab view="calendar"><PersonalCalendarScreen /></WorkspaceTab>;
}

function PersonalCalendarScreen() {
  const { snapshot, error, refresh, database, readError } = usePlannerData();
  const local = useLocalCalendar(database);
  const today = snapshot?.today ?? localDateFromDate(new Date());
  const [selectedDate, setSelectedDate] = useState<LocalDate>(today);
  const completion = useTaskCompletion(database, refresh, readError, undefined, snapshot?.household);
  const tasksFor = snapshot ? personalCalendarTasks(snapshot, today, completion.project) : () => [] as DateTask[];
  if (!snapshot) return <PlannerLoadState title="カレンダー" message="予定を読み込んでいます。" error={error} retry={refresh} />;
  const chores = new Map(snapshot.chores.map(chore => [chore.id, chore])); const hidden = new Set(snapshot.hiddenWasteOccurrenceKeys);
  const navigate = (tab: 'home' | 'calendar' | 'chores' | 'appliances') => router.navigate(({ home: '/(tabs)', calendar: '/(tabs)/explore', chores: '/(tabs)/guide', appliances: '/(tabs)/manual' } as const)[tab]);
  const open = (choreId: string) => router.navigate({ pathname: '/(tabs)/guide', params: { choreId, returnTo: 'calendar' } });
  const renderTask = (task: DateTask, date: LocalDate) => {
    const chore = chores.get(task.choreId); if (!chore) return null;
    return <Animated.View key={`${task.id}:${date}`} layout={LinearTransition.duration(240)}><TaskCheckboxRow compact chore={chore} completed={task.completed} source="personal" seasonalWork={task.entry?.seasonalWork ?? task.completion?.seasonalWork} executionWindow={task.entry ? { start: task.entry.windowStart, end: task.entry.windowEnd } : task.completion?.scheduledWindowStart && task.completion?.scheduledWindowEnd ? { start: task.completion.scheduledWindowStart, end: task.completion.scheduledWindowEnd } : undefined}
      onOpen={() => open(chore.id)} onToggle={completion.canToggle(task) ? () => void completion.toggle(task) : undefined} /></Animated.View>;
  };
  return <SafeAreaView edges={['top']} style={styles.safe}>
    <PlannerCalendar today={today} timeZone={snapshot.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} selectedDate={selectedDate} onSelectDate={setSelectedDate} local={local}
      busy={completion.pending.size > 0} onNavigate={navigate}
      wasteSchedules={snapshot.wasteSchedules} hiddenWasteKeys={snapshot.hiddenWasteOccurrenceKeys}
      dayInfo={date => ({ loaded: date <= addDays(today, 180), pending: tasksFor(date).filter(task => !task.completed).length, total: tasksFor(date).length,
        minutes: tasksFor(date).filter(task => !task.completed).reduce((sum, task) => sum + (chores.get(task.choreId)?.estimatedMinutes ?? 0), 0) })}
      existingChores={snapshot.chores.filter(chore => chore.enabled && !chore.archived).map(chore => ({ id: chore.id, name: chore.name, minutes: chore.estimatedMinutes, onOpen: () => open(chore.id) }))}
      notice={error || completion.error ? <View style={styles.notice}><Text accessibilityRole="alert" style={styles.error}>{completion.error ?? error}</Text><AppButton title={completion.recoveryLabel ?? '表示を再読込'} variant="quiet" compact disabled={completion.pending.size > 0 || completion.reading} onPress={() => void completion.retryRead()} /></View> : null}
      renderWaste={date => <View style={styles.waste}>{snapshot.wasteSchedules.flatMap(schedule => generateWasteCollectionDates(schedule, date, date))
        .filter(item => !hidden.has(`${item.scheduleId}:${item.date}`)).map(item => {
        const key = `${item.scheduleId}:${item.date}`; return <WasteOccurrenceCard key={key} occurrence={item} compact />;
      })}</View>}
      renderChores={date => {
        const tasks = tasksFor(date);
        return <View style={styles.tasks}>{tasks.length ? tasks.map(task => renderTask(task, date)) : <Text style={styles.caption}>{date > addDays(today, 180) ? 'この日の家事はまだ計算されていません。' : 'この日の家事はありません。'}</Text>}</View>;
      }} />
    {completion.undoAvailable ? <View style={styles.toast}><CompletionToast onUndo={() => void completion.undoLast()} /></View> : null}
  </SafeAreaView>;
}
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: palette.background }, notice: { padding: 10, gap: 6 }, error: { ...typography.caption, color: palette.warning },
  caption: { ...typography.caption, color: palette.muted }, tasks: { gap: 4 }, waste: { paddingHorizontal: 6, gap: 4 },
  toast: { position: 'absolute', bottom: 8, left: 0, right: 0 },
});
