import { useRef, useState } from 'react';
import { FlatList, Pressable, Text, View, useColorScheme } from 'react-native';
import { SettingsHeader } from '../../components/settings-header';
import { SettingsAction } from '../../components/settings-controls';
import { Chevron } from '../../components/chevron';
import { typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { formatJapaneseDate } from '../../domain/scheduling/local-date';
import { calendarDraftKey, clearCalendarEditorDraft, type CalendarEditorDraft } from '../../platform/storage/calendar-events';
import type { LocalCalendarBinding } from './use-local-calendar';

export function CalendarDraftList({ drafts, local, onClose, onSelect }: { drafts: readonly CalendarEditorDraft[]; local: LocalCalendarBinding; onClose(): void; onSelect(draft: CalendarEditorDraft): void }) {
  const colors = plannerColorsForScheme(useColorScheme()); const pending = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const discard = async (draft: CalendarEditorDraft) => {
    if (pending.current || !local.database) return; pending.current = true; setBusy(true); setError(null);
    try { await clearCalendarEditorDraft(local.database, draft); await local.refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '下書きを破棄できませんでした。'); }
    finally { pending.current = false; setBusy(false); }
  };
  return <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: 4 }}>
    <View style={{ paddingHorizontal: 12 }}><SettingsHeader title="下書き" onBack={onClose} backDisabled={busy} /></View>
    {error ? <Text accessibilityRole="alert" style={{ ...typography.caption, color: colors.warning, padding: 14 }}>{error}</Text> : null}
    <FlatList testID="calendar-drafts" data={drafts} keyExtractor={calendarDraftKey} initialNumToRender={10}
      ListEmptyComponent={<Text style={{ ...typography.caption, color: colors.muted, padding: 16 }}>下書きはありません</Text>}
      renderItem={({ item }) => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: 14 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${item.value.title || '無題の予定'}の下書きを再開`} disabled={busy} onPress={() => { if (!pending.current) onSelect(item); }} style={{ flex: 1, paddingVertical: 14, gap: 10, flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1, gap: 4 }}><Text numberOfLines={1} style={{ ...typography.body, color: colors.ink }}>{item.value.title || '無題の予定'}</Text>
          <Text numberOfLines={1} style={{ ...typography.caption, color: colors.muted }}>{formatJapaneseDate(item.value.startDate, { year: true })}</Text></View><Chevron color={colors.accent} />
        </Pressable><SettingsAction title="破棄" accessibilityLabel={`${item.value.title || '無題の予定'}の下書きを破棄`} intent="destructive" disabled={busy} onPress={() => void discard(item)} />
      </View>} />
  </View>;
}
