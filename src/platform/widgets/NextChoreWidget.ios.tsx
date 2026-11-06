import { Button, HStack, Text, VStack } from '@expo/ui/swift-ui';
import {
  buttonStyle,
  containerBackground,
  font,
  foregroundStyle,
  lineLimit,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget } from 'expo-widgets';

import type { NextChoreWidgetDisplayProps } from '@/features/widgets/contracts';

function NextChoreWidget(props: NextChoreWidgetDisplayProps) {
  'widget';

  // This is an isolated native widget render, without React hooks; a stale OS snapshot must still check its deadline.
  // eslint-disable-next-line react-hooks/purity
  const locked = props.subscriptionLocked || props.accessUntil !== undefined && !(Date.now() < props.accessUntil);
  const currentDate = new Date();
  const localDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
  const stale = props.contentStale || props.contentUntil !== undefined && currentDate.getTime() >= props.contentUntil
    || props.displayTimeZone !== undefined && !Number.isFinite(props.contentUntil)
    || props.displayTimeZone === undefined && props.displayDate !== undefined && props.displayDate !== localDate;
  const chores = locked || stale ? [] : props.chores ?? [];
  const remainingCount = locked || stale ? 0 : props.remainingCount ?? 0;

  return (
    <VStack alignment="leading" spacing={6} modifiers={[padding({ all: 14 }), containerBackground('#FFFFFF', 'widget')] }>
      <Text modifiers={[font({ size: 17, weight: 'bold' }), foregroundStyle('#292C3B')]}>
        今日の家事
      </Text>
      {chores.length === 0 ? (
        <Text modifiers={[font({ size: 13 }), foregroundStyle('#68718B')]}>{locked ? 'アプリで契約を確認' : stale ? 'アプリで更新' : '予定はありません'}</Text>
      ) : chores.map((chore) => {
        // Only code inside this function is serialized into the widget runtime.
        const content = (
          <HStack key={chore.id} alignment="center" spacing={7}>
            <Text modifiers={[font({ size: 16, weight: 'semibold' }), foregroundStyle(chore.completed ? '#4AADE0' : '#68718B')]}>
              {chore.completed ? '✓' : '○'}
            </Text>
            <Text modifiers={[font({ size: 13, weight: chore.completed ? 'regular' : 'medium' }), foregroundStyle(chore.completed ? '#68718B' : '#292C3B'), lineLimit(1)]}>
              {chore.name}
            </Text>
          </HStack>
        );

        if (chore.completed) return content;

        return (
          <Button
            key={chore.id}
            target={`complete:${chore.id}`}
            onPress={() => props.accessUntil !== undefined && !(Date.now() < props.accessUntil) ? ({
              chores: [], subscriptionLocked: true, remainingCount: 0,
              pendingWidgetCompletionIds: props.pendingWidgetCompletionIds ?? [],
            }) : props.contentUntil !== undefined && Date.now() >= props.contentUntil || props.displayTimeZone !== undefined && !Number.isFinite(props.contentUntil) || props.displayTimeZone === undefined && props.displayDate !== undefined && props.displayDate !== `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}` ? ({
              chores: [], contentStale: true, remainingCount: 0, pendingWidgetCompletionIds: props.pendingWidgetCompletionIds ?? [],
            }) : ({
              chores: (props.chores ?? []).map((item) => item.id === chore.id ? { ...item, completed: true } : item),
              pendingWidgetCompletionIds: [...new Set([...(props.pendingWidgetCompletionIds ?? []), chore.id])],
            })}
            modifiers={[buttonStyle('plain')]}
          >
            {content}
          </Button>
        );
      })}
      {remainingCount > 0 ? (
        <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle('#68718B')]}>
          ほか{remainingCount}件
        </Text>
      ) : null}
    </VStack>
  );
}

export default createWidget('NextChoreWidget', NextChoreWidget, {
  chores: [],
  pendingWidgetCompletionIds: [],
  remainingCount: 0,
  updatedAt: '',
});
