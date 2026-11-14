import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import type { ListViewToken, ViewProps } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Animated, { ReduceMotion, SlideInLeft, SlideInRight, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView } from '@/components/screen-safe-area';
import type { ChoreDefinition } from '../domain/chores/types';
import { groupChores } from '../domain/chores/chore-groups';
import { choreFamilies, type PresentedChore } from '../domain/chores/chore-presentation';
import { BackButton, navigationHeaderMetrics, palette, typography } from './planner-ui';
import { ChoreCategoryRail } from './chore-category-rail';
import { Chevron } from './chevron';
import { plannerColorsForScheme } from './planner-theme';
import { finishStartupDisplay } from '../platform/diagnostics/startup-splash';
import { createChoreDocumentPosition } from './chore-document-position';
import { ChoreScrollIndicator } from './chore-scroll-indicator';

const enterFromLeft = SlideInLeft.duration(180).reduceMotion(ReduceMotion.System);
const enterFromRight = SlideInRight.duration(180).reduceMotion(ReduceMotion.System);
const chapterGap = 24;

// Native anchoring needs a stable view for the chapter, rather than flattened
// descendants whose native tags can be recycled when earlier cells are added.
function ChoreCell({ children, style, onLayout, onFocusCapture }: Pick<ViewProps, 'children' | 'style' | 'onLayout' | 'onFocusCapture'>) {
  return <View collapsable={false} style={style} onLayout={onLayout} onFocusCapture={onFocusCapture}>{children}</View>;
}

/** A continuous, virtualized document. The header and category rail never scroll away. */
export function ChoreBook<T extends PresentedChore & { id: string; name: string } = ChoreDefinition>({ chores, selectedId, renderChore, onBack, header, title, titleAccessory, hasTabBar = false, banner, collapseSplits = false, beforeCollapse,
  chapterGroups, showCategory = true, embedded = false, cardChapters = false, itemLabel = '家事', backAccessibilityLabel, backDisabled = false, renderBatchSize = 2, footer, bottomPadding }: {
  chores: readonly T[]; selectedId?: string; title: string; header?: ReactNode;
  titleAccessory?: ReactNode | ((chore: T | undefined) => ReactNode);
  renderChore(chore: T, options?: { hideHeading: boolean }): ReactNode; onBack(): void;
  hasTabBar?: boolean;
  banner?: ReactNode;
  collapseSplits?: boolean;
  beforeCollapse?(chore: T): Promise<boolean>;
  /** Non-chore documents provide their reviewed order instead of catalog grouping. */
  chapterGroups?: readonly (readonly [string, readonly T[]])[];
  showCategory?: boolean; embedded?: boolean; cardChapters?: boolean; itemLabel?: string; backAccessibilityLabel?: string; backDisabled?: boolean; renderBatchSize?: number;
  footer?: ReactNode;
  bottomPadding?: number;
}) {
  const scheme = useColorScheme(); const colors = plannerColorsForScheme(scheme);
  const { documentTransition } = useLocalSearchParams<{ documentTransition?: string }>();
  const [categoryInset, setCategoryInset] = useState(36);
  const groups = useMemo(() => chapterGroups ?? groupChores(chores), [chapterGroups, chores]);
  const displayCategories = useMemo(() => new Map(groups.flatMap(([name, rows]) => rows.map(row => [row.id, name] as const))), [groups]);
  const latestCategories = useRef(displayCategories);
  useEffect(() => { latestCategories.current = displayCategories; }, [displayCategories]);
  const ordered = useMemo(() => groups.flatMap(([, rows]) => rows), [groups]);
  const splitIds = useMemo(() => new Set(collapseSplits ? choreFamilies(ordered).flatMap(family => family.children.map(chore => chore.id)) : []), [collapseSplits, ordered]);
  const [expandedSplits, setExpandedSplits] = useState(() => new Set(selectedId ? [selectedId] : []));
  const collapsing = useRef(new Set<string>());
  const toggleSplit = useCallback(async (chore: T) => {
    if (!expandedSplits.has(chore.id)) { setExpandedSplits(current => new Set(current).add(chore.id)); return; }
    if (collapsing.current.has(chore.id)) return;
    collapsing.current.add(chore.id);
    try {
      if (beforeCollapse && !await beforeCollapse(chore)) return;
      setExpandedSplits(current => { const next = new Set(current); next.delete(chore.id); return next; });
    } finally { collapsing.current.delete(chore.id); }
  }, [beforeCollapse, expandedSplits]);
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
  const offset = useRef(0); const viewport = useRef(0); const browsing = useRef(false); const prepended = useRef(false); const backwards = useRef(false);
  const list = useRef<FlatList<T>>(null);
  const touch = useRef({ y: 0, nearStart: false, active: false });
  const prependAnchor = useRef<{ ids: string[]; heights: Map<string, number>; offset: number; originOffset: number; nativeShifted: boolean; epoch: number } | null>(null);
  const restoreFrame = useRef<number | null>(null); const restoringFrom = useRef<number | null>(null);
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
  useEffect(() => () => { clearTimeout(hideIndicator.current); if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current); }, []);
  const [category, setCategory] = useState(displayCategories.get(selectedId ?? '') ?? groups[0]?.[0] ?? '');
  const [visibleId, setVisibleId] = useState(selectedId ?? ordered[0]?.id);
  const scrubbing = useRef(false);
  const onScrubChange = useCallback((active: boolean) => { scrubbing.current = active; }, []);
  const visibleCategory = missingStart ? '' : displayCategories.get(visibleId ?? '') ?? category;
  const hasCategory = showCategory && Boolean(visibleCategory);
  const railGroups = useMemo(() => groups.map(([name, chores]) => ({ name, chores })), [groups]);
  const insets = useSafeAreaInsets();
  const documentBottomPadding = bottomPadding ?? (hasTabBar ? 20 : Math.max(20, insets.bottom));
  useLayoutEffect(() => {
    publishPosition(position.update({ chapters: ordered.map(chore => ({ id: chore.id,
      estimate: splitIds.has(chore.id) && !expandedSplits.has(chore.id) ? 48 : collapseSplits ? 420 : 640 })),
    startId: startId ?? '', gap: collapseSplits ? 0 : chapterGap,
    padding: (hasCategory ? categoryInset : 8) + documentBottomPadding }));
  }, [position, publishPosition, ordered, splitIds, expandedSplits, collapseSplits, startId, hasCategory, categoryInset, documentBottomPadding]);
  const jump = useCallback((id: string) => {
    const index = latest.current.findIndex(row => row.id === id);
    setExpandedSplits(current => current.has(id) ? current : new Set(current).add(id));
    setStartId(id); offset.current = 0; browsing.current = false; prepended.current = false; backwards.current = false;
    prependAnchor.current = null; restoringFrom.current = null;
    if (restoreFrame.current !== null) { cancelAnimationFrame(restoreFrame.current); restoreFrame.current = null; }
    currentEpoch.current++; setListEpoch(currentEpoch.current);
    setCategory(index < 0 ? '' : latestCategories.current.get(id) ?? '');
    setVisibleId(id);
    publishPosition(position.jump(id));
  }, [position, publishPosition]);
  const prependEarlier = useCallback((atOffset = offset.current) => {
    if (!browsing.current || !backwards.current || prepended.current || prependAnchor.current) return;
    const index = latest.current.findIndex(chore => chore.id === startId);
    if (index <= 0) return;
    const preceding = latest.current.slice(Math.max(0, index - 2), index);
    prepended.current = true;
    prependAnchor.current = { ids: preceding.map(chore => chore.id), heights: new Map(), offset: atOffset, originOffset: Math.max(0, atOffset), nativeShifted: false, epoch: currentEpoch.current };
    setStartId(preceding[0].id);
  }, [startId]);
  const measureChapter = useCallback((id: string, height: number) => {
    publishPosition(position.measure(id, height));
    const anchor = prependAnchor.current;
    if (!anchor || anchor.epoch !== currentEpoch.current || !anchor.ids.includes(id) || !Number.isFinite(height) || height <= 0) return;
    anchor.heights.set(id, height);
    if (anchor.heights.size !== anchor.ids.length || restoreFrame.current !== null) return;
    // Give native anchoring its layout frame. Issuing scrollToOffset even when
    // native already preserved the chapter cancels the user's upward momentum.
    restoreFrame.current = requestAnimationFrame(() => {
      restoreFrame.current = null;
      if (prependAnchor.current !== anchor || anchor.epoch !== currentEpoch.current) return;
      const nextOffset = Math.max(0, anchor.offset + anchor.ids.reduce((sum, id) => sum + anchor.heights.get(id)!, 0) + anchor.ids.length * (collapseSplits ? 0 : chapterGap));
      prependAnchor.current = null; touch.current.nearStart = false;
      if (anchor.nativeShifted) {
        prepended.current = false;
        publishPosition(position.scroll(offset.current, viewport.current));
      } else {
        restoringFrom.current = anchor.originOffset;
        list.current?.scrollToOffset({ offset: nextOffset, animated: false });
        publishPosition(position.scroll(nextOffset, viewport.current));
      }
    });
  }, [collapseSplits, position, publishPosition]);
  const previousSelection = useRef(selectedId);
  useEffect(() => {
    if (previousSelection.current !== selectedId && selectedId) jump(selectedId);
    previousSelection.current = selectedId;
  }, [selectedId, jump]);
  const visible = useCallback(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    if (listEpoch !== currentEpoch.current || scrubbing.current || prependAnchor.current) return;
    const first = viewableItems.find(item => item.isViewable)?.item;
    if (first) { setCategory(latestCategories.current.get(first.id) ?? ''); setVisibleId(first.id); }
  }, [listEpoch]);
  // A visible-heading update must not rebuild the native list and its measured
  // chapters. Data, settings and theme changes still invalidate this subtree.
  const chapterList = useMemo(() => (
      <FlatList ref={list} key={listEpoch} data={missingStart ? [] : ordered.slice(start)} keyExtractor={chore => chore.id} initialNumToRender={renderBatchSize} maxToRenderPerBatch={renderBatchSize} windowSize={5}
        CellRendererComponent={ChoreCell} maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        removeClippedSubviews={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} contentContainerStyle={[styles.content, collapseSplits && styles.settingsContent, { paddingTop: hasCategory ? categoryInset : 8, paddingBottom: documentBottomPadding }]} ListHeaderComponent={header ? <>{header}</> : undefined}
        ListFooterComponent={footer ? <>{footer}</> : undefined}
        onViewableItemsChanged={visible} viewabilityConfig={{ itemVisiblePercentThreshold: 0 }}
        onTouchStart={event => { touch.current = { y: event.nativeEvent.pageY, nearStart: offset.current < 4, active: true }; browsing.current = true; prepended.current = false; backwards.current = false; restoringFrom.current = null; }}
        onTouchMove={event => {
          const distance = event.nativeEvent.pageY - touch.current.y;
          if (!missingStart && touch.current.nearStart && distance > 10) {
            backwards.current = true;
            if (prependAnchor.current) prependAnchor.current.offset = -distance;
            prependEarlier(-distance);
          }
        }}
        onTouchEnd={() => { touch.current.active = false; browsing.current = false; }}
        onTouchCancel={() => { touch.current.active = false; browsing.current = false; }}
        onLayout={event => { viewport.current = event.nativeEvent.layout.height; publishPosition(position.scroll(offset.current, viewport.current)); }}
        onScroll={event => { const previous = offset.current; offset.current = Math.max(0, event.nativeEvent.contentOffset.y);
          const anchor = prependAnchor.current;
          if (anchor && offset.current > anchor.originOffset + 4) anchor.nativeShifted = true;
          // Once the restored native position is observed, another preceding
          // range may load during this same drag or momentum scroll.
          if (restoringFrom.current !== null && offset.current > restoringFrom.current + 4) { restoringFrom.current = null; prepended.current = false; }
          if (browsing.current) backwards.current = event.nativeEvent.contentOffset.y < previous;
          if (!missingStart && offset.current < 4 && event.nativeEvent.contentOffset.y < previous) prependEarlier(event.nativeEvent.contentOffset.y);
          publishPosition(position.scroll(offset.current, event.nativeEvent.layoutMeasurement.height)); }} scrollEventThrottle={32}
        onScrollBeginDrag={event => {
          // Native anchoring may adjust the offset before a throttled scroll
          // event reaches JS. Do not mistake that old zero for the top edge.
          if (event?.nativeEvent?.contentOffset) offset.current = Math.max(0, event.nativeEvent.contentOffset.y);
          browsing.current = true;
          if (touch.current.active) touch.current.nearStart = offset.current < 4;
          if (!touch.current.active) { prepended.current = false; backwards.current = false; restoringFrom.current = null; }
          beginScroll();
          // Use the scroll gesture rather than raw touch movement: wheel, trackpad and
          // assistive scrolling must be able to reach chapters before the selected one.
        }} onScrollEndDrag={event => { if (!event.nativeEvent.velocity?.y) browsing.current = false; endScroll(); }}
        onMomentumScrollBegin={() => { browsing.current = true; beginScroll(); }}
        onStartReached={() => { if (!missingStart && offset.current < Math.max(4, viewport.current)) prependEarlier(); }} onStartReachedThreshold={1}
        onMomentumScrollEnd={() => { browsing.current = false; endScroll(); }}
        ListEmptyComponent={<Text style={styles.caption}>{missingStart ? `この${itemLabel}を表示できません。` : `表示できる${itemLabel}がありません。`}</Text>}
        renderItem={({ item, index }) => {
          const split = splitIds.has(item.id); const expanded = expandedSplits.has(item.id);
          const followsSplitGroup = collapseSplits && start + index > 0 && !split && splitIds.has(ordered[start + index - 1].id);
          return <View onLayout={event => measureChapter(item.id, event.nativeEvent.layout.height)}
            style={[styles.chapter, { borderBottomColor: colors.border }, cardChapters && styles.cardChapter, collapseSplits && styles.settingsChapter,
            split && [styles.splitChapter, expanded ? styles.expandedSplitChapter : { borderBottomColor: colors.border }], followsSplitGroup && styles.afterSplitGroup]}>
            {split ? <Pressable accessibilityRole="button" accessibilityLabel={`${item.name}の設定を${expanded ? '閉じる' : '開く'}`}
              accessibilityState={{ expanded }} onPress={() => void toggleSplit(item).catch(() => undefined)} style={styles.splitHeading}>
              <Text style={styles.splitTitle}>{item.name}</Text><Chevron direction={expanded ? 'up' : 'down'} />
            </Pressable> : null}
            {!split || expanded ? renderChore(item, { hideHeading: split }) : null}
          </View>;
        }} />
  ), [listEpoch, missingStart, ordered, start, collapseSplits, hasCategory, categoryInset, documentBottomPadding, header, visible,
    prependEarlier, position, publishPosition, beginScroll, endScroll, splitIds, expandedSplits, colors.border, renderChore, toggleSplit, measureChapter, renderBatchSize, itemLabel, cardChapters, footer]);
  const document = <>
    {banner}
    <View style={styles.captionBar}>
      <View style={styles.captionTop}><BackButton onPress={onBack} accessibilityLabel={backAccessibilityLabel} disabled={backDisabled} />
        <View pointerEvents="none" style={styles.captionTitleSlot}><Text numberOfLines={1} style={styles.captionTitle}>{title}</Text></View>
        {titleAccessory ? <View style={styles.captionAccessory}>{typeof titleAccessory === 'function' ? titleAccessory(ordered.find(chore => chore.id === visibleId)) : titleAccessory}</View> : null}
      </View>
    </View>
    <Animated.View entering={documentTransition === 'left' ? enterFromLeft : documentTransition === 'right' ? enterFromRight : undefined} style={styles.document}>
      {hasCategory ? <View pointerEvents="none" style={styles.categoryOverlay}><View style={styles.categoryLane}>
        <View style={[styles.categoryBadge, { borderColor: colors.border, backgroundColor: colors.elevated }]} onLayout={event => {
          const height = event.nativeEvent.layout.height;
          if (Number.isFinite(height) && height > 0) setCategoryInset(Math.ceil(height) + 8);
        }}><Text accessibilityRole="header" numberOfLines={1} style={styles.category}>{visibleCategory}</Text></View>
      </View></View> : null}
      {chapterList}
      <ChoreCategoryRail groups={railGroups} category={visibleCategory} selectedId={visibleId} onSelect={jump} onScrubChange={onScrubChange} itemLabel={itemLabel} />
      <ChoreScrollIndicator progress={indicatorProgress} fraction={indicatorFraction} opacity={indicatorOpacity} />
    </Animated.View>
  </>;
  return embedded ? <View style={styles.safe}>{document}</View> : <SafeAreaView style={styles.safe} edges={['top']} onLayout={finishStartupDisplay}>{document}</SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background }, document: { flex: 1 },
  captionBar: { ...navigationHeaderMetrics, minHeight: 52, paddingVertical: 4 },
  captionTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }, captionAccessory: { flexShrink: 0 },
  captionTitleSlot: { position: 'absolute', left: 84, right: 84, top: 0, bottom: 0, justifyContent: 'center' },
  captionTitle: { ...typography.body, color: palette.ink, fontWeight: '700', textAlign: 'center' }, caption: { ...typography.caption, color: palette.muted },
  categoryOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2, alignItems: 'center' },
  categoryLane: { width: '100%', maxWidth: 820, paddingLeft: 13, paddingRight: 42, alignItems: 'flex-start' },
  content: { paddingLeft: 16, paddingRight: 42, paddingTop: 32, paddingBottom: 20, gap: chapterGap, maxWidth: 820, width: '100%', alignSelf: 'center' },
  chapter: { gap: 12, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: palette.border },
  cardChapter: { paddingBottom: 0, borderBottomWidth: 0 },
  settingsContent: { gap: 0 }, settingsChapter: { paddingTop: 0, paddingBottom: 30, borderBottomWidth: 0 }, splitChapter: { paddingTop: 0, paddingBottom: 0, borderBottomWidth: 1 },
  expandedSplitChapter: { borderBottomWidth: 0, paddingBottom: 30 },
  afterSplitGroup: { paddingTop: 18 },
  categoryBadge: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, maxWidth: '100%' },
  category: { ...typography.caption, color: palette.muted, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 3 },
  splitHeading: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  splitTitle: { ...typography.body, color: palette.ink, fontWeight: '600', flex: 1 },
});
