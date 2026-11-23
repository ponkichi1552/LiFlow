import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme, useWindowDimensions } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton, typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import type { CalendarView } from './display-store';
import { calendarHelpPlacement, type CalendarHelpTargets } from './help-targets';

export function CalendarHelp({ onClose, onShow, measureTargets, view = 'month' }: {
  onClose(): void; onShow(): void; view?: CalendarView;
  measureTargets?(done: (targets: CalendarHelpTargets) => void): () => void;
}) {
  const colors = plannerColorsForScheme(useColorScheme()); const insets = useSafeAreaInsets(); const { width, height } = useWindowDimensions();
  const [visible, setVisible] = useState(true), [step, setStep] = useState(0), [targets, setTargets] = useState<CalendarHelpTargets>({}), [cardHeight, setCardHeight] = useState(270);
  const finished = useRef(false);
  const stopMeasurement = useRef<(() => void) | undefined>(undefined);
  const measure = useCallback(() => { stopMeasurement.current?.(); stopMeasurement.current = measureTargets?.(setTargets); }, [measureTargets]);
  useEffect(() => { measure(); return () => stopMeasurement.current?.(); }, [measure, width, height]);
  const finish = () => { if (finished.current) return; finished.current = true; onClose(); };
  const close = () => { setVisible(false); if (Platform.OS !== 'ios') finish(); };
  const movableView = view === 'month' || view === 'day' || view === 'two' || view === 'three' || view === 'week';
  const steps = [
    { target: targets.add, title: '予定・家事を追加', body: '右上の＋から登録。予定名に「明日18時に食事」などと入れると、日時も入力できます。', detail: '1日・2日・3日・7日は、空き時間の長押しでも予定を追加できます。' },
    { target: movableView ? targets.event ?? targets.calendar : targets.mode, title: '予定は、長押しして移動',
      body: !movableView ? '月・1日・2日・3日・7日表示で、予定を長押ししたまま移動できます。' : !targets.event ? '追加した予定を長押ししたまま動かすと、日時を変更できます。' : view === 'month' ? '予定を長押ししたまま別の日へ。時刻は変わりません。上下端では自動でスクロールします。' : '予定を長押ししたまま動かすと、日付・時刻を変更できます。',
      detail: '繰り返しは範囲を選択。個別に変更した回はそのまま。移動後は「元に戻す」で戻せます。' },
    { target: targets.mode, title: '表示・詳しさを切り替える', body: '1日・2日・3日・7日・リストを選べます。月表示では「すっきり・標準・詳しく」もここで選択。', detail: '7日は1週間を表示。1日・2日・3日は左右で日付を変更。月・年は上下にスクロール。' },
    { target: targets.search, title: '予定・家事を探す', body: '虫眼鏡から検索し、結果を押すとその日付へ移動します。', detail: '隣の？から、この案内をいつでも開けます。' },
  ];
  const current = steps[step], safe = { width, height, top: insets.top, bottom: insets.bottom };
  const layout = calendarHelpPlacement(safe, current.target, cardHeight), hole = layout.target, arrow = layout.arrow;
  return <Modal visible={visible} animationType="fade" transparent presentationStyle="overFullScreen" statusBarTranslucent navigationBarTranslucent onShow={() => { onShow(); measure(); }} onRequestClose={close} onDismiss={finish}>
    <View style={styles.root} accessibilityViewIsModal>
      {hole ? <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={[styles.shade, { backgroundColor: colors.overlay, left: 0, top: 0, width, height: hole.y }]} />
        <View style={[styles.shade, { backgroundColor: colors.overlay, left: 0, top: hole.y + hole.height, width, bottom: 0 }]} />
        <View style={[styles.shade, { backgroundColor: colors.overlay, left: 0, top: hole.y, width: hole.x, height: hole.height }]} />
        <View style={[styles.shade, { backgroundColor: colors.overlay, left: hole.x + hole.width, right: 0, top: hole.y, height: hole.height }]} />
        <View testID="calendar-help-target" style={[styles.outline, { left: hole.x, top: hole.y, width: hole.width, height: hole.height, borderColor: colors.accent }]} />
      </View> : <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]} />}
      {arrow ? <Svg pointerEvents="none" width={width} height={height} style={StyleSheet.absoluteFill}><Path d={`M${arrow.fromX} ${arrow.fromY} L${arrow.toX} ${arrow.toY} m-6 ${-arrow.direction * 7} l6 ${arrow.direction * 7} l6 ${-arrow.direction * 7}`} fill="none" stroke={colors.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" /></Svg> : null}
      <View style={[styles.card, { left: layout.left, top: layout.top, width: layout.width, maxHeight: height - insets.top - insets.bottom - 32, backgroundColor: colors.surface, borderColor: colors.border }]}
        onLayout={event => { const next = event.nativeEvent.layout.height; if (next > 0 && Math.abs(next - cardHeight) > 1) setCardHeight(next); }}>
        <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={styles.copy}>
          <Text style={[styles.count, { color: colors.muted }]}>カレンダーの使い方 {step + 1}/{steps.length}</Text>
          <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={[styles.title, { color: colors.ink }]}>{current.title}</Text>
          <Text style={[styles.body, { color: colors.ink }]}>{current.body}</Text><Text style={[styles.detail, { color: colors.muted }]}>{current.detail}</Text>
        </ScrollView>
        <View style={styles.actions}><Pressable accessibilityRole="button" accessibilityLabel="カレンダーのヘルプを閉じる" onPress={close} style={styles.close}><Text style={[styles.body, { color: colors.accent }]}>閉じる</Text></Pressable>
          <View style={styles.stepControls}>
            {step > 0 ? <AppButton title="前へ" accessibilityLabel="カレンダーの案内を前へ" compact variant="quiet" onPress={() => setStep(value => Math.max(0, value - 1))} /> : null}
            <AppButton title={step === steps.length - 1 ? '完了' : '次へ'} accessibilityLabel={step === steps.length - 1 ? 'カレンダーの案内を完了' : 'カレンダーの案内を次へ'} compact onPress={() => { if (step === steps.length - 1) close(); else setStep(value => value + 1); }} />
          </View>
        </View>
      </View>
    </View>
  </Modal>;
}
const styles = StyleSheet.create({
  root: { flex: 1 }, shade: { position: 'absolute' }, outline: { position: 'absolute', borderWidth: 2, borderRadius: 10 },
  card: { position: 'absolute', borderRadius: 16, borderWidth: 1, padding: 16, gap: 12, boxShadow: '0 4px 20px #00000025' },
  copy: { gap: 10 }, count: { ...typography.caption }, title: { ...typography.control, fontWeight: '600' }, body: { ...typography.label }, detail: { ...typography.caption },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, close: { minWidth: 64, minHeight: 44, justifyContent: 'center' },
  stepControls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
});
