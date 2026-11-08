import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import type { ListViewToken } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Animated, { ReduceMotion, SlideInLeft, SlideInRight, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView } from '@/components/screen-safe-area';
import type { ChoreDefinition } from '../domain/chores/types';
import { groupChores } from '../domain/chores/chore-groups';
import { choreFamilies } from '../domain/chores/chore-presentation';
import { BackButton, navigationHeaderMetrics, palette, typography } from './planner-ui';
import { ChoreCategoryRail } from './chore-category-rail';
import { Chevron } from './chevron';
import { plannerColorsForScheme } from './planner-theme';
import { finishStartupDisplay } from '../platform/diagnostics/startup-splash';
import { createChoreDocumentPosition } from './chore-document-position';
import { ChoreScrollIndicator } from './chore-scroll-indicator';

const enterFromLeft = SlideInLeft.duration(180).reduceMotion(ReduceMotion.System);
const enterFromRight = SlideInRight.duration(180).reduceMotion(ReduceMotion.System);

/** A continuous, virtualized document. The header and category rail never scroll away. */
export function ChoreBook({ chores, selectedId, renderChore, onBack, header, title, titleAccessory, hasTabBar = false, banner, collapseSplits = false, beforeCollapse }: {
  chores: readonly ChoreDefinition[]; selectedId?: string; title: string; header?: ReactNode;
  titleAccessory?: ReactNode | ((chore: ChoreDefinition | undefined) => ReactNode);
  renderChore(chore: ChoreDefinition, options?: { hideHeading: boolean }): ReactNode; onBack(): void;
  hasTabBar?: boolean;
  banner?: ReactNode;
  collapseSplits?: boolean;
  beforeCollapse?(chore: ChoreDefinition): Promise<boolean>;
}) {
  const scheme = useColorScheme(); const colors = plannerColorsForScheme(scheme);
  const { documentTransition } = useLocalSearchParams<{ documentTransition?: string }>();
  const [categoryInset, setCategoryInset] = useState(36);
  const groups = useMemo(() => groupChores(chores), [chores]);
  const displayCategories = useMemo(() => new Map(groups.flatMap(([name, rows]) => rows.map(row => [row.id, name] as const))), [groups]);
  const latestCategories = useRef(displayCategories);
  useEffect(() => { latestCategories.current = displayCategories; }, [displayCategories]);
  const ordered = useMemo(() => groups.flatMap(([, rows]) => rows), [groups]);
  const splitIds = useMemo(() => new Set(collapseSplits ? choreFamilies(ordered).flatMap(family => family.children.map(chore => chore.id)) : []), [collapseSplits, ordered]);
  const [expandedSplits, setExpandedSplits] = useState(() => new Set(selectedId ? [selectedId] : []));
  const collapsing = useRef(new Set<string>());
  const toggleSplit = async (chore: ChoreDefinition) => {
    if (!expandedSplits.has(chore.id)) { setExpandedSplits(current => new Set(current).add(chore.id)); return; }
    if (collapsing.current.has(chore.id)) return;
    collapsing.current.add(chore.id);
    try {
      if (beforeCollapse && !await beforeCollapse(chore)) return;
      setExpandedSplits(current => { const next = new Set(current); next.delete(chore.id); return next; });
    } finally { collapsing.current.delete(chore.id); }
  };
  const [initialId] = useState(selectedId);
  const initialIndex = Math.max(0, ordered.findIndex(row => row.id === initialId));
  // Start at the requested chapter without guessing variable heights or scrolling through other chores.
  // Earlier chapters are prepended in small batches only when the user browses backwards.
  const [startId, setStartId] = useState<string | null>(selectedId ?? ordered[initialIndex]?.id ?? null);
  const startIndex = startId ? ordered.findIndex(chore => chore.id === startId) : 0;
  const missingStart = startIndex < 0;
  const start = Math.max(0, startIndex);
  const latest = useRef(ordered);
  useLayoutEffect(() => { latest.current = ordered; }, [ordered]);
  const [listEpoch, setListEpoch] = useState(0); const currentEpoch = useRef(0);
  const offset = useRef(0); const touch = useRef({ y: 0, nearStart: false, prepended: false }); const backwards = useRef(false);
  const position = useMemo(() => createChoreDocumentPosition(), []);
  const indicatorProgress = useSharedValue(0), indicatorFraction = useSharedValue(1), indicatorOpacity = useSharedValue(0);
  const hideIndicator = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const publishPosition = useCallback((value: { progress: number; fraction: number }) => {
    indicatorProgress.set(withTiming(value.progress, { duration: 80, reduceMotion: ReduceMotion.System }));
    indicatorFraction.set(withTiming(value.fraction, { duration: 200, reduceMotion: ReduceMotion.System }));
  }, [indicatorProgress, indicatorFraction]);
  const beginScroll = useCallback(() => {
    clearTimeout(hideIndicator.current);
    indicatorOpacity.set(withTiming(0.6, { duration: 80, reduceMotion: ReduceMotion.System }));
  }, [indicatorOpacity]);
  const endScroll = useCallback(() => {
    clearTimeout(hideIndicator.current);
    hideIndicator.current = setTimeout(() => { indicatorOpacity.set(withTiming(0, { duration: 200, reduceMotion: ReduceMotion.System })); }, 250);
  }, [indicatorOpacity]);
  useEffect(() => () => clearTimeout(hideIndicator.current), []);
  const [category, setCategory] = useState(displayCategories.get(selectedId ?? '') ?? groups[0]?.[0] ?? '');
  const [visibleId, setVisibleId] = useState(selectedId ?? ordered[0]?.id);
  const scrubbing = useRef(false);
  const onScrubChange = useCallback((active: boolean) => { scrubbing.current = active; }, []);
  const visibleCategory = missingStart ? '' : displayCategories.get(visibleId ?? '') ?? category;
  const insets = useSafeAreaInsets();
  useLayoutEffect(() => {
    publishPosition(position.update({ chapters: ordered.map(chore => ({ id: chore.id,
      estimate: splitIds.has(chore.id) && !expandedSplits.has(chore.id) ? 48 : collapseSplits ? 420 : 640 })),
    startId: startId ?? '', gap: collapseSplits ? 0 : 24,
    padding: (visibleCategory ? categoryInset : 8) + (hasTabBar ? 20 : Math.max(20, insets.bottom)) }));
  }, [position, publishPosition, ordered, splitIds, expandedSplits, collapseSplits, startId, visibleCategory, categoryInset, hasTabBar, insets.bottom]);
  const jump = useCallback((id: string) => {
    const index = latest.current.findIndex(row => row.id === id);
    setExpandedSplits(current => current.has(id) ? current : new Set(current).add(id));
    setStartId(id); offset.current = 0; backwards.current = false;
    currentEpoch.current++; setListEpoch(currentEpoch.current);
    setCategory(index < 0 ? '' : latestCategories.current.get(id) ?? '');
    setVisibleId(id);
    publishPosition(position.jump(id));
  }, [position, publishPosition]);
  const prependEarlier = useCallback(() => {
    setStartId(id => {
      if (!id) return id;
      const index = latest.current.findIndex(chore => chore.id === id);
      return index > 0 ? latest.current[Math.max(0, index - 2)].id : id;
    });
  }, []);
  const previousSelection = useRef(selectedId);
  useEffect(() => {
    if (previousSelection.current !== selectedId && selectedId) jump(selectedId);
    previousSelection.current = selectedId;
  }, [selectedId, jump]);
  const visible = useCallback(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    if (listEpoch !== currentEpoch.current || scrubbing.current) return;
    const first = viewableItems.find(item => item.isViewable)?.item;
    if (first) { setCategory(latestCategories.current.get(first.id) ?? ''); setVisibleId(first.id); }
  }, [listEpoch]);
  return <SafeAreaView style={styles.safe} edges={['top']} onLayout={finishStartupDisplay}>
    {banner}
    <View style={styles.captionBar}>
      <View style={styles.captionTop}><BackButton onPress={onBack} />
        <View pointerEvents="none" style={styles.captionTitleSlot}><Text numberOfLines={1} style={styles.captionTitle}>{title}</Text></View>
        {titleAccessory ? <View style={styles.captionAccessory}>{typeof titleAccessory === 'function' ? titleAccessory(ordered.find(chore => chore.id === visibleId)) : titleAccessory}</View> : null}
      </View>
    </View>
    <Animated.View entering={documentTransition === 'left' ? enterFromLeft : documentTransition === 'right' ? enterFromRight : undefined} style={styles.document}>
      {visibleCategory ? <View pointerEvents="none" style={styles.categoryOverlay}><View style={styles.categoryLane}>
        <View style={[styles.categoryBadge, { borderColor: colors.border, backgroundColor: colors.elevated }]} onLayout={event => {
          const height = event.nativeEvent.layout.height;
          if (Number.isFinite(height) && height > 0) setCategoryInset(Math.ceil(height) + 8);
        }}><Text accessibilityRole="header" numberOfLines={1} style={styles.category}>{visibleCategory}</Text></View>
      </View></View> : null}
      <FlatList key={listEpoch} data={missingStart ? [] : ordered.slice(start)} keyExtractor={chore => chore.id} initialNumToRender={2} maxToRenderPerBatch={2} windowSize={5}
        maintainVisibleContentPosition={{ minIndexForVisible: header ? 1 : 0 }}
        removeClippedSubviews={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} contentContainerStyle={[styles.content, collapseSplits && styles.settingsContent, { paddingTop: visibleCategory ? categoryInset : 8, paddingBottom: hasTabBar ? 20 : Math.max(20, insets.bottom) }]} ListHeaderComponent={header ? <>{header}</> : undefined}
        onViewableItemsChanged={visible} viewabilityConfig={{ itemVisiblePercentThreshold: 0 }}
        onTouchStart={event => { touch.current = { y: event.nativeEvent.pageY, nearStart: offset.current < 4, prepended: false }; backwards.current = false; }}
        onTouchMove={event => {
          if (event.nativeEvent.pageY - touch.current.y <= 10) return;
          backwards.current = true;
          if (!missingStart && touch.current.nearStart && !touch.current.prepended) { touch.current.prepended = true; prependEarlier(); }
        }}
        onLayout={event => { publishPosition(position.scroll(offset.current, event.nativeEvent.layout.height)); }}
        onScroll={event => { offset.current = Math.max(0, event.nativeEvent.contentOffset.y);
          publishPosition(position.scroll(offset.current, event.nativeEvent.layoutMeasurement.height)); }} scrollEventThrottle={32}
        onScrollBeginDrag={beginScroll} onScrollEndDrag={endScroll} onMomentumScrollBegin={beginScroll}
        onStartReached={() => { if (backwards.current && !missingStart) prependEarlier(); }} onStartReachedThreshold={0.15}
        onMomentumScrollEnd={() => { backwards.current = false; endScroll(); }}
        ListEmptyComponent={<Text style={styles.caption}>{missingStart ? 'この家事を表示できません。' : '表示できる家事がありません。'}</Text>}
        renderItem={({ item, index }) => {
          const split = splitIds.has(item.id); const expanded = expandedSplits.has(item.id);
          const followsSplitGroup = collapseSplits && index > 0 && !split && splitIds.has(ordered[start + index - 1].id);
          return <View onLayout={event => publishPosition(position.measure(item.id, event.nativeEvent.layout.height))}
            style={[styles.chapter, { borderBottomColor: colors.border }, collapseSplits && styles.settingsChapter,
            split && [styles.splitChapter, expanded ? styles.expandedSplitChapter : { borderBottomColor: colors.border }], followsSplitGroup && styles.afterSplitGroup]}>
            {split ? <Pressable accessibilityRole="button" accessibilityLabel={`${item.name}の設定を${expanded ? '閉じる' : '開く'}`}
              accessibilityState={{ expanded }} onPress={() => void toggleSplit(item).catch(() => undefined)} style={styles.splitHeading}>
              <Text style={styles.splitTitle}>{item.name}</Text><Chevron direction={expanded ? 'up' : 'down'} />
            </Pressable> : null}
            {!split || expanded ? renderChore(item, { hideHeading: split }) : null}
          </View>;
        }} />
      <ChoreCategoryRail groups={groups.map(([name, chores]) => ({ name, chores }))} category={visibleCategory} selectedId={visibleId} onSelect={jump} onScrubChange={onScrubChange} />
      <ChoreScrollIndicator progress={indicatorProgress} fraction={indicatorFraction} opacity={indicatorOpacity} />
    </Animated.View>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background }, document: { flex: 1 },
  captionBar: { ...navigationHeaderMetrics, minHeight: 52, paddingVertical: 4 },
  captionTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }, captionAccessory: { flexShrink: 0 },
  captionTitleSlot: { position: 'absolute', left: 84, right: 84, top: 0, bottom: 0, justifyContent: 'center' },
  captionTitle: { ...typography.body, color: palette.ink, fontWeight: '700', textAlign: 'center' }, caption: { ...typography.caption, color: palette.muted },
  categoryOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2, alignItems: 'center' },
  categoryLane: { width: '100%', maxWidth: 820, paddingLeft: 13, paddingRight: 42, alignItems: 'flex-start' },
  content: { paddingLeft: 16, paddingRight: 42, paddingTop: 32, paddingBottom: 20, gap: 24, maxWidth: 820, width: '100%', alignSelf: 'center' },
  chapter: { gap: 12, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: palette.border },
  settingsContent: { gap: 0 }, settingsChapter: { paddingTop: 0, paddingBottom: 30, borderBottomWidth: 0 }, splitChapter: { paddingTop: 0, paddingBottom: 0, borderBottomWidth: 1 },
  expandedSplitChapter: { borderBottomWidth: 0, paddingBottom: 30 },
  afterSplitGroup: { paddingTop: 18 },
  categoryBadge: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, maxWidth: '100%' },
  category: { ...typography.caption, color: palette.muted, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 3 },
  splitHeading: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  splitTitle: { ...typography.body, color: palette.ink, fontWeight: '600', flex: 1 },
});
