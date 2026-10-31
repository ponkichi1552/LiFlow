import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Chevron } from './chevron';
import { Card, palette, typography } from '@/components/planner-ui';

const DURATION = 220;

export function AccordionSection({ title, summary, summaryError = false, expanded, onToggle, children }: {
  title: string;
  summary?: string;
  summaryError?: boolean;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const height = useSharedValue(0);
  const [retainContent, setRetainContent] = useState(expanded);
  if (expanded && !retainContent) setRetainContent(true);
  const bodyStyle = useAnimatedStyle(() => ({
    height: withTiming(expanded ? height.value : 0, { duration: DURATION }),
  }), [expanded]);
  const measureContent = (event: LayoutChangeEvent) => {
    height.value = event.nativeEvent.layout.height;
  };

  useEffect(() => {
    if (expanded) return;
    // Keep the body during collapse, then remove its controls from keyboard navigation too.
    const timeout = setTimeout(() => setRetainContent(false), DURATION);
    return () => clearTimeout(timeout);
  }, [expanded]);

  return (
    <Card style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}を${expanded ? '閉じる' : '開く'}`}
        accessibilityValue={summary ? { text: summary } : undefined}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <Text style={[styles.title, summary && styles.titleWithSummary]}>{title}</Text>
        {summary ? <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.summary, summaryError && styles.summaryError]}>{summary}</Text> : null}
        <Chevron direction={expanded ? 'up' : 'down'} />
      </Pressable>
      <Animated.View
        style={[styles.clip, bodyStyle]}
        pointerEvents={expanded ? 'auto' : 'none'}
        accessibilityElementsHidden={!expanded}
        importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
      >
        {expanded || retainContent ? (
          <View style={styles.content} onLayout={measureContent}>
            {children}
          </View>
        ) : null}
      </Animated.View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 0, paddingVertical: 4, overflow: 'hidden' },
  header: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  pressed: { opacity: 0.72 },
  title: { ...typography.section, flex: 1, color: palette.ink, fontWeight: '700' },
  titleWithSummary: { flex: 0, maxWidth: '75%' },
  summary: { ...typography.caption, color: palette.muted, flex: 1, minWidth: 0, textAlign: 'right' },
  summaryError: { color: palette.warning },
  chevron: { color: palette.accent, fontSize: 23, fontWeight: '700', lineHeight: 28 },
  chevronExpanded: { transform: [{ rotate: '180deg' }] },
  clip: { overflow: 'hidden', position: 'relative' },
  // Explicitly anchor the body. Yoga's automatic absolute position can move as the parent height changes.
  content: { position: 'absolute', top: 0, left: 0, right: 0, gap: 12, paddingTop: 8, paddingBottom: 10 },
});
