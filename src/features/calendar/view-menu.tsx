import { useState } from 'react';
import { MONTH_DETAILS, type CalendarMonthDetail } from './month-detail-store';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette, typography } from '../../components/planner-ui';
import type { CalendarDetailView } from './display-store';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { SettingsCheckbox } from '../../components/settings-checkbox';
export const CALENDAR_DETAIL_LABELS = { day: '1日', two: '2日', three: '3日', week: '7日', list: 'リスト' } as const;

export function CalendarViewMenu({ value, onSelect, onClose, overview = false, monthDetail, onMonthDetail, titleShortening, onTitleShortening }: {
  value: CalendarDetailView; onSelect: (value: CalendarDetailView) => void; onClose: () => void;
  overview?: boolean;
  monthDetail?: CalendarMonthDetail; onMonthDetail?(value: CalendarMonthDetail): void;
  titleShortening?: boolean; onTitleShortening?(value: boolean): void;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const insets = useSafeAreaInsets(); const { height, width } = useWindowDimensions(); const [error, setError] = useState<string | null>(null);
  const menuWidth = Math.min(monthDetail || onTitleShortening ? 254 : 148, width - insets.left - insets.right - 24);
  return <Modal transparent animationType="fade" onRequestClose={onClose}><View style={styles.overlay}>
    <Pressable accessibilityRole="button" accessibilityLabel="表示の選択を閉じる" style={StyleSheet.absoluteFill} onPress={onClose} />
    <View accessibilityViewIsModal style={[styles.menu, { width: menuWidth, right: Math.min(66 + insets.right, width - insets.left - menuWidth - 12),
      top: insets.top + 54, maxHeight: Math.max(100, height - insets.top - insets.bottom - 70) }]}>
      <ScrollView>
      {overview ? <Text accessibilityRole="header" style={[styles.caption, { paddingTop: 8 }]}>日付を開くときの表示</Text> : null}
      {(Object.keys(CALENDAR_DETAIL_LABELS) as CalendarDetailView[]).map(mode => <Pressable key={mode} accessibilityRole="button" accessibilityLabel={`${CALENDAR_DETAIL_LABELS[mode]}表示`} accessibilityState={{ selected: value === mode }}
        onPress={() => { onSelect(mode); onClose(); }} style={({ pressed }) => [styles.option, value === mode && styles.pressed, pressed && { opacity: .7 }]}>
        <Text style={styles.label}>{CALENDAR_DETAIL_LABELS[mode]}</Text>{value === mode ? <Text aria-hidden style={styles.check}>✓</Text> : null}
      </Pressable>)}
      {monthDetail && onMonthDetail ? <View style={styles.detailGroup}><Text style={styles.caption}>月表示の詳しさ</Text>
        {MONTH_DETAILS.map(row => <Pressable key={row.value} accessibilityRole="button" accessibilityLabel={`月表示を${row.label}にする`} accessibilityState={{ selected: monthDetail === row.value }}
          onPress={() => { try { onMonthDetail(row.value); onClose(); } catch { setError('表示設定を保存できませんでした。'); } }} style={({ pressed }) => [styles.option, monthDetail === row.value && styles.pressed, pressed && { opacity: .7 }]}>
          <View style={{ flex: 1 }}><Text style={styles.label}>{row.label}</Text><Text style={styles.detailCaption}>{row.caption}</Text></View>{monthDetail === row.value ? <Text aria-hidden style={styles.check}>✓</Text> : null}
        </Pressable>)}
      </View> : null}
      {onTitleShortening ? <View style={[styles.detailGroup, styles.titlePreference]}>
        <SettingsCheckbox value={titleShortening !== false} label="予定名の日時表現を省略" description="Googleへの送信にも適用"
          onValueChange={next => { try { onTitleShortening(next); setError(null); } catch { setError('表示設定を保存できませんでした。'); } }} />
      </View> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </View>
  </View></Modal>;
}
const baseStyles = StyleSheet.create({
  overlay: { flex: 1 }, menu: { position: 'absolute', paddingVertical: 4, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border, borderRadius: 12, overflow: 'hidden', boxShadow: '0 3px 12px #00000030' },
  detailGroup: { borderTopWidth: 1, borderColor: palette.border, paddingTop: 8 }, caption: { ...typography.caption, color: palette.muted, paddingHorizontal: 16, paddingBottom: 4 }, detailCaption: { ...typography.caption, color: palette.muted }, error: { ...typography.caption, color: palette.warning, padding: 12 },
  titlePreference: { paddingHorizontal: 16, paddingBottom: 8 },
  option: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12 }, label: { ...typography.body, color: palette.ink, flex: 1 }, check: { ...typography.body, color: palette.accent }, pressed: { backgroundColor: palette.accentSoft },
});
