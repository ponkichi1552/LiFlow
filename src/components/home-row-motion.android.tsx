import { createContext, useCallback, useContext, useEffect, useRef, type PropsWithChildren } from 'react';
import { AccessibilityInfo, Animated, Easing, FlatList, useAnimatedValue } from 'react-native';
import type { FlatListProps, LayoutChangeEvent, ViewProps } from 'react-native';

const MotionAllowed = createContext<{ current: boolean } | null>(null);
const reorderEasing = Easing.inOut(Easing.quad);

export function HomeRowMotionScope({ children }: PropsWithChildren) {
  const allowed = useRef(false);
  useEffect(() => {
    let mounted = true;
    let updated = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', reduced => {
      updated = true;
      allowed.current = !reduced;
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(reduced => {
      if (mounted && !updated) allowed.current = !reduced;
    }).catch(() => undefined);
    return () => { mounted = false; allowed.current = false; subscription.remove(); };
  }, []);
  return <MotionAllowed.Provider value={allowed}>{children}</MotionAllowed.Provider>;
}

/** Move an existing keyed row with Android's native Animated driver on reorder. */
export function HomeMotionRow({ children, index, onLayout, onFocusCapture, style }: PropsWithChildren<
  { index: number } & Pick<ViewProps, 'onLayout' | 'onFocusCapture' | 'style'>
>) {
  const allowed = useContext(MotionAllowed);
  const translation = useAnimatedValue(0);
  const previous = useRef<{ index: number; y: number } | null>(null);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; translation.stopAnimation(); }, [translation]);
  const measure = useCallback((event: LayoutChangeEvent) => {
    const { y } = event.nativeEvent.layout;
    const old = previous.current;
    previous.current = { index, y };
    onLayout?.(event);
    if (!allowed?.current || !old || old.index === index || old.y === y) return;

    const change = ++revision.current;
    translation.stopAnimation(value => {
      if (revision.current !== change) return;
      if (!allowed.current) { translation.setValue(0); return; }
      translation.setValue(value + old.y - y);
      Animated.timing(translation, {
        toValue: 0, duration: 240, easing: reorderEasing, useNativeDriver: true, isInteraction: false,
      }).start();
    });
  }, [allowed, index, onLayout, translation]);
  return <Animated.View onLayout={measure} onFocusCapture={onFocusCapture} style={[style, { transform: [{ translateY: translation }] }]}>
    {children}
  </Animated.View>;
}

export function HomeMotionList<Item>(props: FlatListProps<Item>) {
  return <HomeRowMotionScope>
    <FlatList {...props} CellRendererComponent={HomeMotionRow} />
  </HomeRowMotionScope>;
}
