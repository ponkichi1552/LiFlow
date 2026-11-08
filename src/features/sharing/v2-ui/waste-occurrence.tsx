import { Text, View } from 'react-native';
import { AppButton, palette, typography } from '../../../components/planner-ui';
import { WasteOccurrenceCard } from '../../../components/waste-occurrence-card';
import type { V2GroupController } from '../v2/controller';
import type { V2WasteOccurrence as WasteEntry } from '../v2/waste-state';

/** An unresolved hide/show decision stays visible and cannot masquerade as an unchecked box. */
export function V2WasteOccurrence({ entry, compact, home, editing }: {
  entry: WasteEntry; compact?: boolean; home?: boolean; editing?: { busy: boolean; actions: V2GroupController['actions'];
    run: (work: () => Promise<unknown>) => Promise<void> };
}) {
  return <View style={{ gap: 6 }}>
    <WasteOccurrenceCard occurrence={entry.occurrence} compact={compact} home={home} hidden={entry.hidden === true} busy={editing?.busy || entry.hidden === null} listRow={Boolean(editing)}
      onToggle={editing ? () => void editing.run(() => editing.actions.setWasteOccurrenceHidden(entry.selection, !entry.hidden)) : undefined} />
    {entry.hidden === null ? <View style={{ gap: 6 }}>
      <Text style={{ ...typography.caption, color: palette.warning }}>{editing ? '表示と非表示の変更が重なりました。この収集日の扱いを選んでください。' : '表示設定が重なっています。'}</Text>
      {editing ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <AppButton title="この収集日を表示する" compact variant="quiet" disabled={editing.busy} onPress={() => void editing.run(() => editing.actions.setWasteOccurrenceHidden(entry.selection, false, true))} />
        <AppButton title="この収集日を非表示にする" compact variant="quiet" disabled={editing.busy} onPress={() => void editing.run(() => editing.actions.setWasteOccurrenceHidden(entry.selection, true, true))} />
      </View> : null}
    </View> : null}
  </View>;
}
