import { useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import { usePlannerData } from '@/hooks/use-planner-data';
import { useLocalCalendar } from './use-local-calendar';
import { CalendarEditor } from './calendar-editor';
import { newEventDraft } from './events';
import { localDateFromDate } from '../../domain/scheduling/local-date';
import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';

export function BirthdaySettings() {
  const { database, snapshot } = usePlannerData({ personal: true }); const local = useLocalCalendar(database);
  const [editor, setEditor] = useState<CalendarEditorDraft | null>(null);
  const today = snapshot?.today ?? localDateFromDate(new Date()); const timeZone = snapshot?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <View style={{ gap: 8 }}>
    <Text style={{ ...typography.caption, color: palette.muted }}>誕生日は毎年カレンダーへ表示します。家事の時間を塞ぐ予定にはしません。</Text>
    {local.error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: palette.warning }}>{local.error}</Text> : null}
    {local.snapshot.events.filter(event => event.birthday).map(event => <AppButton key={event.id} title={`${event.title} · ${Number(event.startDate.slice(5, 7))}月${Number(event.startDate.slice(-2))}日`} variant="quiet" compact onPress={() => setEditor({ eventId: event.id, revision: event.revision, anchorDate: null, exceptionRevision: 0, scope: 'series', value: event })} />)}
    <AppButton title="誕生日を追加" variant="secondary" compact onPress={() => setEditor(local.snapshot.drafts?.find(draft => draft.eventId === null && draft.value.birthday) ?? { eventId: null, revision: 0, anchorDate: null, exceptionRevision: 0, scope: 'series', value: newEventDraft(today, timeZone, true) })} />
    {editor ? <CalendarEditor initial={editor} local={local} onClose={() => { setEditor(null); void local.refresh(); }} onSaved={() => { setEditor(null); void local.refresh(); }} /> : null}
  </View>;
}
