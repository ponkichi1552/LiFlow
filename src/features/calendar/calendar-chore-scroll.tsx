import { useEffect, useRef, type ComponentProps, type ComponentRef, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import type { LocalDate } from '../../domain/shared/types';
import { formatJapaneseDate } from '../../domain/scheduling/local-date';

export function CalendarChoreScroll({ day, height, contentHeight, enabled, simultaneousWith, onHeight, children }: {
  day: LocalDate;
  height: number;
  contentHeight?: number;
  enabled: boolean;
  simultaneousWith?: ComponentProps<typeof ScrollView>['simultaneousWith'];
  onHeight(height: number): void;
  children: ReactNode;
}) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const overflow = contentHeight !== undefined && contentHeight > height + 1;
  useEffect(() => {
    if (overflow) scroll.current?.flashScrollIndicators();
  }, [overflow]);
  const date = formatJapaneseDate(day, { year: true });
  return <ScrollView ref={scroll} simultaneousWith={simultaneousWith} disallowInterruption={false} enabled={enabled}
    scrollEnabled={enabled} nestedScrollEnabled showsVerticalScrollIndicator={overflow} persistentScrollbar={overflow}
    contentInsetAdjustmentBehavior="never" accessibilityLabel={`${date}の家事一覧`}
    style={styles.scroll}
    onContentSizeChange={(_width, measured) => onHeight(measured)}>
    {children}
  </ScrollView>;
}
const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
});
