import { useEffect, useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { CalendarDayPicker } from '@/components/calendar-day-picker';
import { palette, typography } from '@/components/planner-ui';
import { SafeAreaView } from '@/components/screen-safe-area';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { OWN_BIRTHDAY_EVENT_ID } from '@/domain/calendar/own-birthday';
import { calendarChorePlacement } from '@/domain/chores/calendar-timing';
import { builtInChoreCatalogEntry } from '@/domain/chores/catalog';
import type { ChoreDefinition } from '@/domain/chores/types';
import { addDays, formatJapaneseDate } from '@/domain/scheduling/local-date';
import { orderTaskRows } from '@/domain/scheduling/task-row-order';
import type { LocalDate } from '@/domain/shared/types';
import { CalendarSheetHeader } from '../../calendar/calendar-sheet-header';
import { calendarChoreTimeLabel } from '../../calendar/chore-time-label';
import { INITIAL_CATEGORIES, UNCATEGORIZED_CALENDAR_CATEGORY, minuteLabel, newEventDraft, recurrenceLabel, type CalendarEvent, type CalendarOccurrence, type EventDraft } from '../../calendar/events';
import { PlannerCalendar } from '../../calendar/planner-calendar';
import type { LocalCalendarBinding } from '../../calendar/use-local-calendar';
import { V2ChoreProcedures } from '../../sharing/v2-ui/chore-procedures';
import { V2PrivateTaskNotice } from '../../sharing/v2-ui/private-task-card';
import type { WeeklyWasteSchedule } from '../../waste/contracts';
import { createCalendarReviewPreferences } from './calendar-preferences';

export const calendarReviewScenarios = [
  { id: 'three', label: '3日表示の個人・共有家事' },
  { id: 'week', label: '7日表示の個人・共有家事' },
  { id: 'overlap', label: '深夜に重なる予定' },
  { id: 'month', label: '予定が重なる月' },
  { id: 'list', label: '長い予定・日をまたぐ予定' },
  { id: 'partial', label: '共有家事だけ取得した日' },
  { id: 'empty', label: '予定も家事もない日' },
] as const;

const today: LocalDate = '2026-11-23';
const zone = 'Asia/Tokyo';
const day = (offset: number) => addDays(today, offset);
const group = 'review-household';
type Source = 'personal' | 'shared';

function appointment(id: string, title: string, offset: number, fields: Partial<EventDraft>): CalendarEvent {
  return { ...newEventDraft(day(offset), zone), id, title, revision: 1, ...fields };
}

const reading = appointment('review-reading', '図書館の読書会', -7, {
  startMinute: 14 * 60, endMinute: 15 * 60, categoryId: 'school', recurrence: 'weekly', untilDate: day(21),
});
const shortOverlapEvents = [
  appointment('review-brief-call', '朝の連絡', 2, { startMinute: 25, endMinute: 30, categoryId: 'work' }),
  appointment('review-brief-check', '荷物の受け取り', 2, { startMinute: 25, endMinute: 35, categoryId: 'work' }),
  appointment('review-uncategorized-a', '荷物を整理する', 1, { startMinute: 65, endMinute: 110, categoryId: UNCATEGORIZED_CALENDAR_CATEGORY.id }),
  appointment('review-uncategorized-b', '家族に連絡する', 1, { startMinute: 75, endMinute: 100, categoryId: UNCATEGORIZED_CALENDAR_CATEGORY.id }),
];
const personalEvents = [
  reading,
  appointment('review-exhibition', 'まちの写真展「川辺の四季」とワークショップの会場設営・当日受付の打ち合わせ', 0, {
    startMinute: 10 * 60, endMinute: 11 * 60 + 15, categoryId: 'school',
    location: 'みどり文化交流センター 東館3階 多目的ホール奥の展示準備室（南側エレベーター前で集合）',
    notes: '展示パネルの並び順を入口から確認する。\n午前中に受付机と通路の幅を確かめ、午後のワークショップ用の用紙と筆記具を準備室にまとめる。\n帰る前に会場図の変更箇所を記録する。',
  }),
  appointment('review-call', 'オンライン編集会議', 0, {
    categoryId: 'work', startMinute: 10 * 60 + 20, endMinute: 11 * 60 + 5, location: 'オンライン会議室',
  }),
  appointment('review-train', '夜行列車で移動', 0, {
    startMinute: 23 * 60 + 20, endDate: day(1), endMinute: 6 * 60 + 40, location: '中央駅・南改札',
  }),
  appointment('review-pickup', '予約した本を受け取る', 1, { startMinute: 18 * 60, endMinute: 18 * 60 + 10 }),
  appointment('review-lunch', '昼休みの散歩', -1, {
    startMinute: 12 * 60 + 10, endMinute: 12 * 60 + 30, recurrence: 'daily', untilDate: day(5),
  }),
  { ...newEventDraft('2000-11-23', zone, true), id: OWN_BIRTHDAY_EVENT_ID, revision: 1, title: '自分の誕生日' },
];
const sharedEvents = [
  appointment('group.review-family-trip', '家族の旅行と帰省', -1, {
    allDay: true, endDate: day(2), categoryId: 'review-family', location: '湖畔の宿',
  }),
  appointment('group.review-workshop', '秋の文化祭・会場案内とスタンプラリー', 0, {
    allDay: true, categoryId: 'review-community', location: '中央公園',
  }),
  appointment('group.review-visit', '台所の設備点検に立ち会う', 0, {
    startMinute: 10 * 60 + 35, endMinute: 11 * 60 + 30, categoryId: 'review-family',
  }),
  appointment('group.review-tent', '前夜から翌々朝までのキャンプ当番', -1, {
    startMinute: 19 * 60, endDate: day(1), endMinute: 7 * 60, categoryId: 'review-community',
  }),
  appointment('group.review-dinner', '夕食の献立と買い出しの相談', 0, {
    startMinute: 18 * 60 + 30, endMinute: 19 * 60, categoryId: 'review-family',
    recurrence: 'custom', customRecurrence: { unit: 'week', interval: 1, weekdays: [1, 3, 5] }, untilDate: day(18),
  }),
];
const sharedEventIds = new Set(sharedEvents.map(event => event.id));
const categories = [...INITIAL_CATEGORIES,
  { id: 'review-family', name: '家族の予定', color: '#BD7042', revision: 1 },
  { id: 'review-community', name: '地域・イベント', color: '#727A91', revision: 1 },
];
const wasteSchedules: WeeklyWasteSchedule[] = [
  { id: 'review-burnable', householdId: group, label: '燃えるごみ', collectionWeekdays: [1, 4] },
  { id: 'review-plastic', householdId: group, label: 'プラスチック', collectionWeekdays: [2] },
  { id: 'review-glass', householdId: group, label: 'びん・缶', collectionWeekdays: [3], recurrence: 'biweekly', anchorDate: day(2) },
  { id: 'review-paper', householdId: group, label: '古紙', collectionWeekdays: [], recurrence: 'monthly', monthlyDay: 23 },
];

type ReviewChore = {
  key: string; definition: ChoreDefinition; source: Source; date: LocalDate; completed: boolean; provisional: boolean;
  windowDays: number; clocks?: readonly [number, number];
};

function choreRounds(source: Source, catalogId: string, offsets: readonly number[], options: {
  name?: string; completedOn?: number; provisionalOn?: number; windowDays?: number; clocks?: ReviewChore['clocks'];
} = {}): ReviewChore[] {
  const base = builtInChoreCatalogEntry(catalogId);
  if (!base) throw new Error(`確認用の家事が見つかりません（${catalogId}）`);
  const definition = { ...base, id: `review.${source}.${base.id}`, householdId: source === 'shared' ? group : 'review-personal',
    enabled: true, name: options.name ?? base.name };
  return offsets.map(offset => ({ key: `${definition.id}:${day(offset)}`, definition, source, date: day(offset),
    completed: offset === options.completedOn, provisional: offset === options.provisionalOn, windowDays: options.windowDays ?? 0, clocks: options.clocks }));
}
const initialChores = [
  ...choreRounds('shared', 'builtin-chore-28', [0], { name: 'リビングと寝室のエアコンのフィルターと吹き出し口を順番に掃除する', windowDays: 2 }),
  ...choreRounds('personal', 'builtin-chore-09', [-1, 0, 2, 5], { name: '寝具カバーの交換と洗濯', completedOn: 0 }),
  ...choreRounds('shared', 'builtin-chore-07', [-1, 0, 3], { name: '洗面所の鏡を拭く' }),
  ...choreRounds('personal', 'builtin-chore-07', [0, 1, 2, 5], { name: '洗面所の鏡を拭く' }),
  ...choreRounds('shared', 'builtin-chore-24', [0, 1, 4], { name: '冷蔵庫の在庫を確かめて週末までに使う食材をまとめる', clocks: [17 * 60, 17 * 60 + 20] }),
  ...choreRounds('personal', 'builtin-chore-10', [-1, 0, 1, 3, 4], { name: '洗濯物を畳んで明日の着替えをそろえる', windowDays: 1 }),
  ...choreRounds('shared', 'builtin-chore-26', [-1, 0, 1, 2, 3, 4, 5]),
  ...choreRounds('personal', 'builtin-chore-15', [0, 2, 4], { name: '玄関の靴をそろえる', provisionalOn: 2 }),
  ...choreRounds('shared', 'builtin-chore-21', [1, 2, 3, 5], { completedOn: 1 }),
  ...choreRounds('personal', 'builtin-chore-22', [0, 4, 5], { name: '洗濯乾燥機のフィルターを確認する', clocks: [23 * 60 + 45, 5] }),
];
function choreTime(row: ReviewChore) {
  if (!row.clocks) return undefined;
  const [startMinute, endMinute] = row.clocks;
  return calendarChorePlacement(row.key, row.date, {
    allDay: false, startMinute, endMinute, endDayOffset: Number(endMinute <= startMinute), timeZone: zone,
  }, true).slot ?? undefined;
}
type Selection = { event: CalendarOccurrence } | { chore: ReviewChore };
const sourceLabel = (source: Source) => source === 'shared' ? '共有' : '個人';

function ReviewDetails({ selection, close, move }: { selection: Selection; close(): void; move(key: string, date: LocalDate): void }) {
  const chore = 'chore' in selection ? selection.chore : undefined;
  const event = 'event' in selection ? selection.event : undefined;
  const [date, setDate] = useState(chore?.date ?? today);
  const canMove = chore && !chore.completed && !chore.provisional;
  const timeLabel = chore && calendarChoreTimeLabel(choreTime({ ...chore, date }), zone);
  const missingTime = Boolean(chore?.clocks && !timeLabel);
  const dateLabel = (value: LocalDate) => formatJapaneseDate(value, { year: true, weekday: true });
  const eventDate = event && (event.allDay
    ? `${dateLabel(event.startDate)}${event.startDate === event.endDate ? '' : `〜${dateLabel(event.endDate)}`} · 終日`
    : `${dateLabel(event.startDate)} ${minuteLabel(event.startMinute)}〜${event.startDate === event.endDate ? '' : dateLabel(event.endDate) + ' '}${minuteLabel(event.endMinute)}`);
  return <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={close}>
    <SafeAreaView style={styles.sheet}>
      <CalendarSheetHeader title={canMove ? '実施日を変更' : event ? '予定の詳細' : '家事の詳細'} closeLabel="詳細を閉じる" onClose={close}
        onSave={canMove ? () => move(chore.key, date) : undefined} saveLabel="今回の実施日を保存" saveDisabled={date === chore?.date || missingTime} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.name}>{event?.title ?? chore?.definition.name}</Text>
        {event ? <>
          <Text style={styles.meta}>{sourceLabel(sharedEventIds.has(event.eventId) ? 'shared' : 'personal')} · {categories.find(category => category.id === event.categoryId)?.name ?? UNCATEGORIZED_CALENDAR_CATEGORY.name}</Text>
          <Text style={styles.body}>{eventDate}{event.recurrence !== 'none' ? ` · ${recurrenceLabel(event)}` : ''}</Text>
          {event.location ? <Text style={styles.body}>{event.location}</Text> : null}
          {event.notes ? <Text style={styles.body}>{event.notes}</Text> : null}
        </> : chore ? <>
          <Text style={styles.meta}>{sourceLabel(chore.source)} · {chore.definition.category}{timeLabel ? ` · ${timeLabel}` : ''}</Text>
          {missingTime ? <Text accessibilityRole="alert" style={styles.meta}>指定の時刻を使える日を選んでください。</Text> : null}
          {canMove ? <CalendarDayPicker today={today} initialDate={chore.date} selected={value => value === date} onSelect={setDate} label="今回の実施日" />
            : <V2ChoreProcedures chore={chore.definition} />}
        </> : null}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

type ScenarioId = typeof calendarReviewScenarios[number]['id'];

function CalendarReviewSession({ scenario, onExit }: { scenario: ScenarioId; onExit?(): void }) {
  const empty = scenario === 'empty';
  const partial = scenario === 'partial';
  const overlapping = scenario === 'overlap';
  const initialView = empty ? 'list' : partial || overlapping ? 'three' : scenario;
  const [preferences] = useState(() => createCalendarReviewPreferences(initialView));
  useEffect(() => () => preferences.display.dispose(), [preferences]);
  const [chores, setChores] = useState(() => empty ? [] : partial
    ? initialChores.filter(row => row.date !== today || row.source === 'shared') : initialChores);
  const [selection, setSelection] = useState<Selection | null>(null);
  const local = useMemo<LocalCalendarBinding>(() => ({
    loading: false, error: null, refresh: async () => {},
    snapshot: { categories, events: empty ? [] : [...personalEvents, ...sharedEvents, ...(overlapping ? shortOverlapEvents : [])], draft: null, exceptions: empty ? [] : [
      { eventId: reading.id, anchorDate: today, revision: 1, override: { ...reading, startDate: today, endDate: today,
        title: '読書会・会場変更', location: '図書館 分館の閲覧室', startMinute: 15 * 60, endMinute: 16 * 60 } },
    ] },
  }), [empty, overlapping]);
  const rowsByDate = useMemo(() => {
    const rows = new Map<LocalDate, ReviewChore[]>();
    for (const row of orderTaskRows(chores, today, item => ({
      completed: item.completed, load: item.definition.load, recommendedDate: item.date,
      windowStart: addDays(item.date, -item.windowDays), windowEnd: addDays(item.date, item.windowDays),
    }))) {
      const list = rows.get(row.date);
      if (list) list.push(row); else rows.set(row.date, [row]);
    }
    return rows;
  }, [chores]);
  const scheduledDates = useMemo(() => new Set(rowsByDate.keys()), [rowsByDate]);
  const timedChores = useMemo(() => chores.flatMap(chore => {
    const time = choreTime(chore);
    return time ? [{ id: chore.key, name: chore.definition.name, ...time, onOpen: () => setSelection({ chore }) }] : [];
  }), [chores]);
  const todayInScenario = empty ? day(1) : today;
  return <View style={styles.calendar}>
    <PlannerCalendar today={todayInScenario} timeZone={zone} local={local} extendedChoreDates={scheduledDates} wasteSchedules={empty ? undefined : wasteSchedules}
      preview={{ preferences, currentMinute: overlapping ? 0 : 10 * 60 + 15, initialExpandedDay: !overlapping && (initialView === 'three' || initialView === 'week') ? today : undefined,
        onInspectEvent: event => setSelection({ event }), onExit }} timedChores={timedChores} searchChoresIncomplete={partial}
      loadSearchChores={() => chores.map(chore => ({ key: chore.key, title: chore.definition.name, date: chore.date, source: chore.source, minute: chore.clocks?.[0] }))}
      dayInfo={date => {
        const rows = rowsByDate.get(date) ?? [];
        const pending = rows.filter(row => !row.completed);
        return { loaded: true, partial: partial && date === today, total: rows.length, pending: pending.length,
          minutes: pending.reduce((value, row) => value + (row.definition.estimatedMinutes ?? 0), 0) };
      }}
      renderChores={(date, view) => <Animated.FlatList testID="calendar-chore-list" data={rowsByDate.get(date) ?? []} scrollEnabled={false}
        itemLayoutAnimation={LinearTransition.duration(240)} initialNumToRender={8} keyExtractor={row => row.key}
        ListHeaderComponent={partial && date === today ? <V2PrivateTaskNotice sharedTimeZone={zone}
          overlay={{ status: 'unavailable', message: 'この日の個人家事は未取得です。' }} /> : undefined}
        renderItem={({ item }) => <TaskCheckboxRow chore={item.definition} source={item.source} compact narrowCalendar={view === 'three' || view === 'week'} mixedSources completed={item.completed} provisional={item.provisional}
          executionWindow={{ start: addDays(date, -item.windowDays), end: addDays(date, item.windowDays) }}
          calendarTimeLabel={view === 'list' ? calendarChoreTimeLabel(choreTime(item), zone) : undefined}
          onOpen={() => setSelection({ chore: item })} onChangeDate={item.completed || item.provisional ? undefined : () => setSelection({ chore: item })} />} />}
    />
    {selection ? <ReviewDetails selection={selection} close={() => setSelection(null)} move={(key, date) => {
      setChores(previous => previous.map(row => row.key === key ? { ...row, date, windowDays: 0 } : row));
      setSelection(null);
    }} /> : null}
  </View>;
}

export function CalendarReview({ scenario, onExit }: { scenario: string; onExit?(): void }) {
  const id = calendarReviewScenarios.find(entry => entry.id === scenario)?.id ?? 'three';
  return <CalendarReviewSession key={id} scenario={id} onExit={onExit} />;
}

const styles = StyleSheet.create({
  calendar: { flex: 1, minHeight: 0 }, sheet: { flex: 1, backgroundColor: palette.surface },
  content: { padding: 16, gap: 12 }, name: { ...typography.subheading, color: palette.ink, fontWeight: '600' },
  meta: { ...typography.caption, color: palette.muted }, body: { ...typography.body, color: palette.ink },
});
