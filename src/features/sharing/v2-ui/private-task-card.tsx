import { useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, Card } from '../../../components/planner-ui';
import { TaskCheckboxRow } from '../../../components/task-checkbox-row';
import { formatJapaneseDate } from '../../../domain/scheduling/local-date';
import type { V2PrivateOverlayState, V2PrivateTaskRow, V2PrivateTaskSource } from './private-overlay';
import { v2FormStyles as styles } from './form-controls';
import { V2ChoreProcedures } from './chore-procedures';
import type { CompletionFeedback } from './completion-feedback';
import { isTaskUrgent } from '../../../domain/scheduling/task-priority';
import type { LocalDate } from '../../../domain/shared/types';
import { sameOccurrenceAfterCompletion } from '../../../domain/scheduling/date-task-reference';

export function V2PrivateTaskNotice({ overlay, sharedTimeZone, date }: { overlay?: V2PrivateOverlayState; sharedTimeZone: string; date?: string }) {
  if (!overlay) return null;
  if (overlay.status === 'unavailable') return <Text accessibilityRole="alert" style={styles.caption}>{overlay.message}</Text>;
  if (overlay.timeZone === sharedTimeZone && overlay.setupCompleted && (!date || date >= overlay.today && date <= overlay.generatedThrough)) return null;
  return <View style={{ gap: 4 }}>
    {overlay.timeZone !== sharedTimeZone ? <Text style={styles.caption}>個人家事：本人のみ · {overlay.timeZone}</Text> : null}
    {overlay.timeZone !== sharedTimeZone ? <Text style={styles.caption}>個人家事は元の日付で表示しています。地域が異なるため、共有家事の推奨日計算には含めていません。</Text> : null}
    {!overlay.setupCompleted ? <Text style={styles.caption}>個人家事の初期設定を完了すると、ここにも表示されます。</Text>
      : date && date > overlay.generatedThrough ? <Text style={styles.caption}>個人予定の通常生成範囲外です。保存済みの予定だけ表示します。</Text>
        : date && date < overlay.today ? <Text style={styles.caption}>過去の個人家事は、端末に残る予定と実施記録を表示します。</Text> : null}
  </View>;
}

/** The shared actions object is deliberately absent. Only the captured personal source accepts this checkbox. */
export function V2PrivateTaskCard({ row, source, busy, run, feedback, today = row.date, home = false, compact = false, mixedSources = false, onOpen }: { row: V2PrivateTaskRow; source?: V2PrivateTaskSource; busy: boolean; feedback?: CompletionFeedback; today?: LocalDate; home?: boolean; compact?: boolean; mixedSources?: boolean;
  onOpen?: () => void; run: (work: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false); const chore = row.chore;
  const completed = feedback?.values.get(row.key) ?? row.completed;
  const queueable = feedback?.supports?.('personal') && feedback.request;
  return <View style={{ gap: 6 }}>
    <TaskCheckboxRow chore={{ ...chore, category: `本人のみ${chore.category ? ` · ${chore.category}` : ''}` }} completed={completed} source="personal" home={home} compact={compact} mixedSources={mixedSources} detailsExpanded={onOpen ? undefined : open}
      executionWindow={row.windowStart && row.windowEnd ? { start: row.windowStart, end: row.windowEnd } : undefined}
      urgent={isTaskUrgent({ completed, load: chore.load, recommendedDate: row.suggestedDate, windowEnd: row.windowEnd }, today)}
      onOpen={onOpen ?? (() => setOpen((value) => !value))}
      onToggle={queueable ? () => feedback!.request!(row.key, !completed, { kind: 'personal',
        command: { date: row.date, graceDays: row.graceDays, choreId: row.chore.id, revision: row.revision } }) : !busy && source && !feedback?.values.has(row.key) ? () => feedback
        ? feedback.run(row.key, !row.completed, async () => {
          const changed = await source.setCompleted(row.key, row.revision, !row.completed);
          if (!changed || row.completed || !home) return;
          try {
            const next = await source.read({ from: row.date, through: row.date }, new Date());
            const saved = [...next.home, ...(next.byDate.get(row.date) ?? [])].find(item => item.key === row.key && item.completed
              && sameOccurrenceAfterCompletion(row.revision, item.revision));
            return saved ? { undo: () => source.setCompleted(saved.key, saved.revision, false) } : undefined;
          } catch { /* A missing Undo receipt must not turn a stored completion into a failed write. */ }
        })
        : run(() => source.setCompleted(row.key, row.revision, !row.completed)) : undefined} />
    {!onOpen ? <Text style={styles.caption}>個人の推奨日：{formatJapaneseDate(row.suggestedDate, { weekday: true })}</Text> : null}
    {open ? <Card><V2ChoreProcedures chore={chore} />
      <AppButton title="手順を閉じる" variant="quiet" compact onPress={() => setOpen(false)} />
    </Card> : null}
  </View>;
}
