import type { PropsWithChildren } from 'react';
import type { FlatListProps } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

const reorder = LinearTransition.duration(240);

export function HomeRowMotionScope({ children }: PropsWithChildren) {
  return children;
}

export function HomeMotionRow({ children }: PropsWithChildren<{ index: number }>) {
  return <Animated.View layout={reorder}>{children}</Animated.View>;
}

export function HomeMotionList<Item>(props: Omit<FlatListProps<Item>, 'CellRendererComponent'>) {
  return <Animated.FlatList {...props} itemLayoutAnimation={reorder} />;
}
