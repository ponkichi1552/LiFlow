import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { recordIncompleteChore } from '@/platform/storage/repository';
import { selectDateTasks } from '@/domain/scheduling/date-tasks';
import { localDateFromDate } from '@/domain/scheduling/local-date';
import { AppButton, palette, typography } from '@/components/planner-ui';

/** Every chapter retains its own history and incomplete action, including after a rail jump. */
export function GuideChapterActions({ choreId, snapshot, database, refresh, personalSource = false }: {
  choreId: string; snapshot: PlannerSnapshot; database: SQLiteDatabase; refresh(): Promise<void>; personalSource?: boolean;
}) {
  const [busy, setBusy] = useState(false); const running = useRef(false); const [message, setMessage] = useState<string | null>(null);
  const today = snapshot.today ?? localDateFromDate(new Date());
  const task = selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3, snapshot.chores, true).find(task => task.choreId === choreId);
  const entry = task ? task.entry : snapshot.scheduleEntries.find(entry => entry.choreId === choreId && entry.suggestedDate >= today);
  const canRecord = Boolean(entry && entry.windowStart <= today);
  const record = async () => {
    if (!entry || !canRecord || running.current) return;
    running.current = true; setBusy(true); setMessage(null);
    try {
      const recorded = await recordIncompleteChore(database, entry);
      setMessage(recorded ? '未完了を記録し、予定を再調整しました。' : 'この予定は現在記録できません。最新の予定を確認してください。');
      await refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '未完了を記録できませんでした。'); }
    finally { running.current = false; setBusy(false); }
  };
  return <View style={{ gap: 8 }}>
    <AppButton title="この家事の実施履歴を見る" onPress={() => router.push({ pathname: '/history', params: { choreId, ...(personalSource ? { source: 'personal' } : {}) } })} variant="secondary" />
    {entry ? <><AppButton title={busy ? '記録中…' : '未完了を記録'} onPress={() => void record()} disabled={!canRecord || busy} variant="quiet" />
      {!canRecord ? <Text style={{ ...typography.body, color: palette.muted }}>実施期間が始まると未完了を記録できます。</Text> : null}</> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={{ ...typography.body, color: palette.muted }}>{message}</Text> : null}
  </View>;
}
