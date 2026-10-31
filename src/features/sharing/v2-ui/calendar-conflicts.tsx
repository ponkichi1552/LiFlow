import { useState } from 'react';
import { Text, View } from 'react-native';
import { AccordionSection } from '../../../components/accordion-section';
import { AppButton, palette, typography } from '../../../components/planner-ui';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { sharedCalendarPayload } from '../v2/calendar-state';
import { minuteLabel } from '../../calendar/events';

export function SharedCalendarConflicts({ model, actions, busy, run }: { model: V2GroupScreenModel; actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const conflicts = (model.calendar ?? []).flatMap(record => [
    ...(record.heads.length > 1 ? [{ record, scope: 'series' as const, anchorDate: null, heads: record.heads }] : []),
    ...record.exceptions.filter(row => row.heads.length > 1).map(row => ({ record, scope: 'one' as const, ...row })),
  ]);
  if (!conflicts.length) return null;
  return <AccordionSection title={`共有予定の変更確認（${conflicts.length}件）`} expanded={open} onToggle={() => setOpen(value => !value)}>
    <Text style={{ ...typography.caption, color: palette.warning }}>変更が重なった予定は、確定するまで通常の予定として表示しません。空き時間が確定した状態ではありません。</Text>
    {conflicts.map(item => <View key={`${item.record.id}:${item.anchorDate}`} style={{ gap: 8 }}>
      {item.heads.map((head, index) => {
        const payload = sharedCalendarPayload(head); const value = payload.value;
        return <View key={head.operationId} style={{ gap: 4 }}><Text style={{ ...typography.label, color: palette.ink }}>{value?.title ?? 'この予定を削除'}</Text>
          {value ? <Text style={{ ...typography.caption, color: palette.muted }}>{value.startDate}〜{value.endDate} · {value.allDay ? '終日' : `${minuteLabel(value.startMinute)}〜${minuteLabel(value.endMinute)}`}</Text> : null}
          {item.record.creatorUserId === model.viewerUserId || model.adminUserId === model.viewerUserId ? <AppButton title={item.scope === 'series' && item.record.exceptions.length ? `候補${index + 1}を採用し、個別変更をリセット` : `候補${index + 1}を採用`} compact variant="secondary" disabled={busy}
            onPress={() => void run(() => actions.saveCalendarEvent({ eventId: item.record.id, scope: item.scope, anchorDate: item.anchorDate,
              basisRevision: JSON.stringify([item.record.heads.map(op => op.operationId).sort(), item.heads.map(op => op.operationId).sort()]),
              value, category: payload.category ? { ...payload.category, revision: 1 } : null, resetExceptions: item.scope === 'series' && item.record.exceptions.length > 0 }))} /> : null}
        </View>;
      })}
    </View>)}
  </AccordionSection>;
}
