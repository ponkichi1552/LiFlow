import { useEffect } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppButton, palette, typography } from '../../components/planner-ui';
import { Chevron } from '../../components/chevron';
import { formatJapaneseDate } from '../../domain/scheduling/local-date';
import type { LocalDate } from '../../domain/shared/types';
import { minuteLabel, type CalendarOccurrence } from './events';
import { calendarDisplayedTitle } from './title-display';

export function CalendarOverlapSheet({ day, events, onClose, onOpen, onShowDay }: {
  day: LocalDate; events: readonly CalendarOccurrence[]; onClose(): void; onOpen(event: CalendarOccurrence): void; onShowDay(): void;
}) {
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => subscription.remove();
  }, [onClose]);
  return <View style={styles.overlay}>
    <Pressable accessibilityElementsHidden importantForAccessibility="no" style={StyleSheet.absoluteFill} onPress={onClose} />
    <View accessibilityViewIsModal style={styles.sheet}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>{formatJapaneseDate(day, { weekday: true })}の重なった予定</Text>
        <AppButton title="閉じる" variant="quiet" compact onPress={onClose} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {events.length ? events.map(event => {
          const title = calendarDisplayedTitle(event);
          const from = event.startDate < day ? `${formatJapaneseDate(event.startDate)} ` : '';
          const through = event.endDate > day ? `${formatJapaneseDate(event.endDate)} ` : '';
          const time = `${from}${minuteLabel(event.startMinute)}〜${through}${minuteLabel(event.endMinute)}`;
          return <Pressable key={event.id} accessibilityRole="button" accessibilityLabel={`${title}、${time}`}
            onPress={() => onOpen(event)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <View style={styles.rowText}>
              <Text style={styles.item}>{title}</Text>
              <Text style={styles.meta}>{time}</Text>
              {event.location ? <Text style={styles.meta}>{event.location}</Text> : null}
            </View>
            <Chevron />
          </Pressable>;
        }) : <Text accessibilityRole="alert" style={styles.empty}>予定が更新されました。</Text>}
      </ScrollView>
      <View style={styles.footer}><AppButton title="この日を1日表示" variant="secondary" onPress={onShowDay} /></View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'flex-end', backgroundColor: palette.overlay },
  sheet: { maxHeight: '78%', minHeight: 0, backgroundColor: palette.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  header: { paddingLeft: 16, paddingRight: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: palette.border },
  title: { ...typography.body, color: palette.ink, fontWeight: '600', flex: 1, paddingVertical: 10 },
  content: { paddingHorizontal: 16 },
  row: { minHeight: 52, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  rowText: { flex: 1, gap: 2 }, item: { ...typography.body, color: palette.ink }, meta: { ...typography.caption, color: palette.muted },
  pressed: { backgroundColor: palette.accentSoft }, empty: { ...typography.body, color: palette.muted, paddingVertical: 12 },
  footer: { padding: 12 },
});
