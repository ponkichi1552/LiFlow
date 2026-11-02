import { Button, Column, Row, Text } from '@expo/ui/jetpack-compose';
import { background, border, fillMaxWidth, padding, paddingAll } from '@expo/ui/jetpack-compose/modifiers';
import { createWidget } from 'expo-widgets';
import type * as React from 'react';

import type { NextChoreWidgetDisplayProps } from '@/features/widgets/contracts';

type InteractiveButtonProps = React.ComponentProps<typeof Button> & { target: string };

function NextChoreWidget(props: NextChoreWidgetDisplayProps) {
  'widget';

  const InteractiveButton = Button as React.ComponentType<InteractiveButtonProps>;
  // This is an isolated native widget render, without React hooks; a stale OS snapshot must still check its deadline.
  // eslint-disable-next-line react-hooks/purity
  const locked = props.subscriptionLocked || props.accessUntil !== undefined && !(Date.now() < props.accessUntil);
  const chores = locked ? [] : props.chores ?? [];
  const remainingCount = locked ? 0 : props.remainingCount ?? 0;

  return (
    <Column
      verticalArrangement="top"
      horizontalAlignment="start"
      modifiers={[paddingAll(14), background('#FFFFFF'), border(1, '#DFE4EF')]}
    >
      <Text color="#292C3B" style={{ fontSize: 17, fontWeight: '700' }}>今日の家事</Text>
      {chores.length === 0 ? (
        <Text color="#68718B" style={{ fontSize: 13 }}>{locked ? 'アプリで契約を確認' : '予定はありません'}</Text>
      ) : chores.map((chore) => {
        // Only code inside this function is serialized into the widget runtime.
        const content = (
          <Row
            key={chore.id}
            horizontalArrangement="start"
            verticalAlignment="center"
            modifiers={[padding(0, 4, 0, 4), fillMaxWidth()]}
          >
            <Text color={chore.completed ? '#4AADE0' : '#68718B'} style={{ fontSize: 16, fontWeight: '600' }}>
              {chore.completed ? '✓' : '○'}
            </Text>
            <Text color={chore.completed ? '#68718B' : '#292C3B'} style={{ fontSize: 13, fontWeight: '500' }}>
              {chore.name}
            </Text>
          </Row>
        );

        if (chore.completed) return content;

        return (
          <InteractiveButton
            key={chore.id}
            target={`complete:${chore.id}`}
            onClick={() => props.accessUntil !== undefined && !(Date.now() < props.accessUntil) ? ({
              chores: [], subscriptionLocked: true, remainingCount: 0,
              pendingWidgetCompletionIds: props.pendingWidgetCompletionIds ?? [],
            }) : ({
              chores: (props.chores ?? []).map((item) => item.id === chore.id ? { ...item, completed: true } : item),
              pendingWidgetCompletionIds: [...new Set([...(props.pendingWidgetCompletionIds ?? []), chore.id])],
            })}
            colors={{ containerColor: '#FFFFFF', contentColor: '#292C3B' }}
            contentPadding={{ start: 0, top: 0, end: 0, bottom: 0 }}
            modifiers={[fillMaxWidth()]}
          >
            {content}
          </InteractiveButton>
        );
      })}
      {remainingCount > 0 ? (
        <Text color="#68718B" style={{ fontSize: 11 }}>ほか{remainingCount}件</Text>
      ) : null}
    </Column>
  );
}

export default createWidget('NextChoreWidget', NextChoreWidget, {
  chores: [],
  pendingWidgetCompletionIds: [],
  remainingCount: 0,
  updatedAt: '',
});
