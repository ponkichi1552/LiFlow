import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import type { ComponentRef } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { AccessibilityActionEvent, LayoutChangeEvent } from 'react-native';
import { palette, typography } from './planner-ui';

type RailTarget = { key: string; name: string; id: string; category: string; kind: 'category' | 'chore' };
type RailPreview = { target: RailTarget; progress: number } | null;

/** A single native gesture surface avoids overlapping tiny touch targets between dense chapter ticks. */
function createRailControl() {
  let element: ComponentRef<typeof View> | null = null;
  let targets: readonly RailTarget[] = [], selectedId = '', height = 0, top: number | null = null, active = false, pageY = 0, lastId = '';
  let onSelect = (_id: string) => {}, onScrubChange = (_active: boolean) => {};
  let onPreview = (_value: RailPreview) => {};
  let gestureGeneration = 0;
  const select = () => {
    if (!active || top === null || height <= 0 || !targets.length) return;
    const progress = Math.max(0, Math.min(1, (pageY - top - 8) / Math.max(1, height - 16)));
    const target = targets[Math.round(progress * (targets.length - 1))];
    onPreview({ target, progress });
    if (target.id !== lastId) { lastId = target.id; onSelect(target.id); }
  };
  const end = () => { gestureGeneration++; active = false; lastId = ''; onPreview(null); onScrubChange(false); };
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: (_event, state) => state.numberActiveTouches === 1,
    onMoveShouldSetPanResponderCapture: (_event, state) => state.numberActiveTouches === 1 && Math.abs(state.dy) > 3,
    onPanResponderGrant: (event, state) => {
      active = true; lastId = ''; pageY = state.moveY || event.nativeEvent.pageY; top = null; onScrubChange(true);
      const generation = ++gestureGeneration;
      // Measure the parent, rather than trusting locationY from one of its small child ticks.
      element?.measureInWindow((_x, y, _width, measuredHeight) => { if (!active || generation !== gestureGeneration) return; top = y; height = measuredHeight; select(); });
    },
    onPanResponderMove: (_event, state) => { if (state.numberActiveTouches === 1) { pageY = state.moveY; select(); } },
    onPanResponderRelease: end, onPanResponderTerminate: end, onPanResponderTerminationRequest: () => true,
  });
  return { panHandlers: pan.panHandlers,
    attach: (value: ComponentRef<typeof View> | null) => { element = value; if (!value) { end(); top = null; } },
    update: (value: { targets: readonly RailTarget[]; selectedId: string; onSelect(id: string): void; onScrubChange(active: boolean): void; onPreview(value: RailPreview): void }) => {
      targets = value.targets; selectedId = value.selectedId; onSelect = value.onSelect; onScrubChange = value.onScrubChange;
      onPreview = value.onPreview;
    },
    layout: (event: LayoutChangeEvent) => { height = event.nativeEvent.layout.height; top = null; },
    accessibilityAction: (event: AccessibilityActionEvent) => {
      const name = event.nativeEvent.actionName; if (name !== 'increment' && name !== 'decrement') return;
      const chores = targets.filter(target => target.kind === 'chore'); const current = chores.findIndex(target => target.id === selectedId);
      const target = chores[Math.max(0, Math.min(chores.length - 1, current < 0 ? 0 : current + (name === 'increment' ? 1 : -1)))]; if (target) onSelect(target.id);
    },
  };
}

/** Long category marks and short chore marks navigate one continuous document. */
export function ChoreCategoryRail({ groups, category, selectedId, onSelect, onScrubChange }: {
  groups: readonly { name: string; chores: readonly { id: string; name: string }[] }[];
  category: string; selectedId?: string; onSelect(id: string): void; onScrubChange(active: boolean): void;
}) {
  const [preview, setPreview] = useState<RailPreview>(null); const { width } = useWindowDimensions();
  const targets = useMemo(() => groups.flatMap(group => [
    ...(group.chores.length ? [{ key: `category:${group.name}`, name: group.name, id: group.chores[0].id, category: group.name, kind: 'category' as const }] : []),
    ...group.chores.map(chore => ({ key: `chore:${chore.id}`, ...chore, category: group.name, kind: 'chore' as const })),
  ]), [groups]);
  const control = useMemo(() => createRailControl(), []);
  const attach = useCallback((value: ComponentRef<typeof View> | null) => control.attach(value), [control]);
  useLayoutEffect(() => { control.update({ targets, selectedId: selectedId ?? '', onSelect, onScrubChange, onPreview: setPreview }); }, [control, targets, selectedId, onSelect, onScrubChange]);
  // Bound native marker work for very large custom catalogs. Scrubbing still addresses every chore.
  const visible = targets.map((target, index) => ({ ...target, index })).filter(target => target.kind === 'category' || targets.length <= 80 || target.index % Math.ceil(targets.length / 75) === 0 || target.index === targets.length - 1);
  return <View ref={attach} onLayout={control.layout} style={styles.rail} {...control.panHandlers}
    accessible accessibilityRole="adjustable" accessibilityLabel="家事の見出しを移動"
    accessibilityHint="上下になぞると個々の家事へ移動します。上下のスワイプでも前後の家事へ移動できます。"
    accessibilityValue={{ text: targets.find(target => target.kind === 'chore' && target.id === selectedId)?.name ?? category }}
    accessibilityActions={[{ name: 'increment', label: '次の家事' }, { name: 'decrement', label: '前の家事' }]} onAccessibilityAction={control.accessibilityAction}>
    <View pointerEvents="none" style={styles.marks}>
      {visible.map(target => <Pressable key={target.key} accessible={false} accessibilityRole="button"
        accessibilityLabel={target.kind === 'category' ? `${target.name}の先頭へ移動` : `${target.name}へ移動`}
        accessibilityState={{ selected: target.kind === 'category' ? category === target.category : selectedId === target.id }}
        onPress={() => onSelect(target.id)} style={[styles.target, { top: `${targets.length > 1 ? target.index / (targets.length - 1) * 100 : 50}%` }]}>
        <View style={[styles.bar, target.kind === 'chore' && styles.short,
          target.kind === 'category' && category === target.category && styles.selectedCategory,
          target.kind === 'chore' && selectedId === target.id && styles.selectedChore]} />
      </Pressable>)}
    </View>
    {preview ? <View pointerEvents="none" accessible={false} style={[styles.preview, { width: Math.min(252, width - 72), top: `${preview.progress * 100}%` }]}>
      {preview.target.kind === 'chore' ? <Text numberOfLines={1} style={styles.previewCategory}>{preview.target.category}</Text> : null}
      <Text numberOfLines={2} style={styles.previewName}>{preview.target.name}</Text>
    </View> : null}
  </View>;
}
const styles = StyleSheet.create({
  rail: { position: 'absolute', right: 0, top: '12%', bottom: '12%', width: 40 },
  marks: { position: 'absolute', top: 8, bottom: 8, left: 0, right: 0 },
  target: { position: 'absolute', marginTop: -8, height: 16, left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  bar: { height: 3, width: 13, backgroundColor: palette.inputBorder, borderRadius: 2 }, short: { height: 2, width: 6 },
  selectedCategory: { width: 20, backgroundColor: palette.accent }, selectedChore: { width: 11, backgroundColor: palette.accent },
  preview: { position: 'absolute', right: 42, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12,
    backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border, transform: [{ translateY: -24 }] },
  previewCategory: { ...typography.caption, color: palette.muted }, previewName: { ...typography.label, color: palette.ink, fontWeight: '600' },
});
