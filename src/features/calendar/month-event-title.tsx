import { memo, useId, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { MONTH_EVENT_ROW_HEIGHT } from './month-density';
import { calendarMonthTitleText } from './month-title-text';

/** Keep native text proportions and fade only titles that extend past their cell. */
export const CalendarMonthEventTitle = memo(function CalendarMonthEventTitle({ title, color, backgroundColor, lines = 1, centerSingleLine = true, onOverflow }: {
  title: string; color: string; backgroundColor: string; lines?: 1 | 2; centerSingleLine?: boolean; onOverflow: (overflow: boolean) => void;
}) {
  const gradient = `month-title-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [measuredLines, setMeasuredLines] = useState(0);
  const wrappingText = calendarMonthTitleText(title, true);
  return <View style={[styles.clip, { height: lines * MONTH_EVENT_ROW_HEIGHT }]}>
    {/* The probe detects overflow for either preview without guessing character widths. */}
    <Text numberOfLines={3} textBreakStrategy="simple" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[styles.text, styles.measure]} onTextLayout={event => {
        setMeasuredLines(event.nativeEvent.lines.length); onOverflow(event.nativeEvent.lines.length > 1);
      }}>{wrappingText}</Text>
    {/* Crop the third line instead of relying on platform-specific multiline ellipsizing. */}
    <Text numberOfLines={lines === 1 ? 1 : 3} ellipsizeMode="clip" textBreakStrategy="simple" accessibilityLabel={title}
      style={[styles.text, styles.visible, centerSingleLine && lines === 1 && measuredLines === 1 && styles.center, { color }]}>{lines === 2 ? wrappingText : calendarMonthTitleText(title)}</Text>
    {measuredLines > lines ? <View pointerEvents="none" accessible={false} style={[styles.fade, { top: (lines - 1) * MONTH_EVENT_ROW_HEIGHT }]}>
      <Svg width={12} height={MONTH_EVENT_ROW_HEIGHT} aria-hidden>
        <Defs><LinearGradient id={gradient} x1="0%" y1="0%" x2="100%" y2="0%">
          <Stop offset="0%" stopColor={backgroundColor} stopOpacity={0} />
          <Stop offset="100%" stopColor={backgroundColor} stopOpacity={1} />
        </LinearGradient></Defs>
        <Rect width={12} height={MONTH_EVENT_ROW_HEIGHT} fill={`url(#${gradient})`} />
      </Svg>
    </View> : null}
  </View>;
});

const styles = StyleSheet.create({
  clip: { width: '100%', minWidth: 0, flexDirection: 'row', overflow: 'hidden', alignItems: 'flex-start' },
  text: { fontSize: 10.5, fontWeight: '600', lineHeight: MONTH_EVENT_ROW_HEIGHT },
  visible: { flex: 1, minWidth: 0 },
  center: { textAlign: 'center' },
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
  fade: { position: 'absolute', right: 0, height: MONTH_EVENT_ROW_HEIGHT, width: 12 },
});
