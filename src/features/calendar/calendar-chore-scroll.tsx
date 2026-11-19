import { useLayoutEffect, useRef, useState, type ComponentProps, type ComponentRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { SymbolView } from 'expo-symbols';
import type { LocalDate } from '../../domain/shared/types';
import { formatJapaneseDate } from '../../domain/scheduling/local-date';
import { palette, typography } from '../../components/planner-ui';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';

export function CalendarChoreScroll({ day, height, contentHeight, enabled, padded, simultaneousWith, onHeight, children }: {
  day: LocalDate;
  height: number;
  contentHeight?: number;
  enabled: boolean;
  padded?: boolean;
  simultaneousWith?: ComponentProps<typeof ScrollView>['simultaneousWith'];
  onHeight(height: number): void;
  children: ReactNode;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const position = useRef({ y: 0, max: 0, page: 0 });
  const [end, setEnd] = useState(false);
  const footerHeight = contentHeight !== undefined && contentHeight > height + 1
    ? Math.min(28, Math.floor(height / 3)) : 0;
  const footer = footerHeight >= 12;
  const viewport = height - (footer ? footerHeight : 0);
  const lastOffset = Math.max(0, (contentHeight ?? 0) - viewport);
  const updateEnd = (y: number, max: number) => setEnd(max > 0 && y >= max - 2);
  useLayoutEffect(() => {
    position.current = { y: Math.min(position.current.y, lastOffset), max: lastOffset, page: viewport };
    setEnd(lastOffset > 0 && position.current.y >= lastOffset - 2);
  }, [lastOffset, viewport]);
  const date = formatJapaneseDate(day, { year: true });
  return <>
    <ScrollView ref={scroll} simultaneousWith={simultaneousWith} disallowInterruption={false} enabled={enabled}
      scrollEnabled={enabled} nestedScrollEnabled contentInsetAdjustmentBehavior="never" accessibilityLabel={`${date}の家事一覧`}
      style={styles.scroll} contentContainerStyle={padded ? styles.padded : undefined}
      onContentSizeChange={(_width, measured) => onHeight(measured)} scrollEventThrottle={32}
      onScroll={footer ? event => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        const max = Math.max(0, contentSize.height - layoutMeasurement.height);
        position.current = { y: contentOffset.y, max, page: layoutMeasurement.height };
        updateEnd(position.current.y, max);
      } : undefined}>
      {children}
    </ScrollView>
    {footer ? <Pressable accessibilityRole="button" accessibilityLabel={`${date}の家事一覧の${end ? '先頭に戻る' : '続きを表示'}`}
      disabled={!enabled} onPress={() => {
        const { y, max, page } = position.current;
        const next = end ? 0 : Math.min(max, Math.max(0, y) + page);
        scroll.current?.scrollTo({ y: next, animated: false });
        position.current.y = next;
        updateEnd(next, max);
      }} style={({ pressed }) => [styles.more, { height: footerHeight }, pressed && styles.pressed]}>
      {footerHeight >= 20 ? <Text maxFontSizeMultiplier={1.25} numberOfLines={1} style={styles.moreText}>{end ? '先頭' : '続き'}</Text> : null}
      <SymbolView aria-hidden name={{ ios: end ? 'chevron.up' : 'chevron.down', android: end ? 'keyboard_arrow_up' : 'keyboard_arrow_down' }}
        size={10} tintColor={palette.accent} />
    </Pressable> : null}
  </>;
}
const baseStyles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  padded: { paddingBottom: 4 },
  more: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.border, backgroundColor: palette.surface },
  moreText: { ...typography.calendarLabel, color: palette.accent },
  pressed: { backgroundColor: palette.accentSoft },
});
