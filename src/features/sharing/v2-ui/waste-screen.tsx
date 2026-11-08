import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { AppButton, Card, NavigationHeader, palette, typography } from '../../../components/planner-ui';
import { SettingsGroup } from '../../../components/settings-controls';
import { WasteScheduleEditor } from '../../waste/waste-schedule-editor';
import { WasteRegistrationHeading, WasteSettingsAction, WasteSettingsItem } from '../../waste/waste-settings-ui';
import { SettingsHeader } from '../../settings/settings-navigation';
import { WasteTypeIcon } from '../../../components/waste-type-icon';
import { normalizeWasteSchedule, wasteCollectionRule, wasteScheduleDescription } from '../../waste/schedule-policy';
import { useWasteTypeColor } from '../../waste/use-waste-type-color';
import type { WasteScheduleInput } from '../../waste/contracts';
import { canonicalJson } from '../operations';
import type { JsonValue } from '../operations';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2WasteEdit, V2WasteField, V2WasteRow } from '../v2/waste-state';
import type { V2MutationOutcome } from './mutation-outcome';
import { V2WasteOccurrence } from './waste-occurrence';

const sourceIds = (field: V2WasteField) => field.candidates.map(candidate => candidate.operationId);
function ruleSummary(value: JsonValue | undefined) {
  try {
    const rule = normalizeWasteSchedule({ ...value as object, label: '収集日' } as WasteScheduleInput);
    return wasteScheduleDescription(rule) + (rule.recurrence === 'monthly' ? '（指定日がない月は月末）' : rule.recurrence === 'biweekly' ? ` · 基準日 ${rule.anchorDate}` : '');
  } catch { return '収集ルールの再入力が必要です。'; }
}
function formEdits(row: V2WasteRow, input: WasteScheduleInput): V2WasteEdit[] {
  const values: Record<'label' | 'rule', JsonValue> = { label: input.label, rule: JSON.parse(canonicalJson(wasteCollectionRule(input))) };
  return (['label', 'rule'] as const).flatMap(field => {
    const source = row.fields[field]; const ids = sourceIds(source);
    if (source.kind === 'value' && canonicalJson(source.value) === canonicalJson(values[field])) return [];
    return [{ field, value: values[field], basisOperationIds: ids, ...(source.kind === 'conflict' ? { resolveOperationIds: ids } : {}) }];
  });
}
function initialForm(row: V2WasteRow): WasteScheduleInput {
  const label = row.fields.label.kind === 'value' && typeof row.fields.label.value === 'string' ? row.fields.label.value : '';
  const rule = row.fields.rule.kind === 'value' && row.fields.rule.value && typeof row.fields.rule.value === 'object' && !Array.isArray(row.fields.rule.value) ? row.fields.rule.value : null;
  return row.schedule ?? { label, collectionWeekdays: [], ...(rule ?? {}) } as WasteScheduleInput;
}

export function V2WasteScreen({ model, actions, busy, perform, onBack, header, embedded = false }: {
  model: V2GroupScreenModel; actions: V2GroupController['actions']; busy: boolean; onBack: () => void; header?: ReactNode;
  embedded?: boolean;
  perform: (work: () => Promise<unknown>) => Promise<V2MutationOutcome>;
}) {
  const wasteTypeColor = useWasteTypeColor();

  const [form, setForm] = useState<{ row?: V2WasteRow; key: number }>({ key: 0 });
  const nextKey = useRef(0); const working = useRef(false);
  const [pendingRead, setPendingRead] = useState(false); const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<V2WasteRow | null>(null);
  const [candidate, setCandidate] = useState<{ id: string; field: 'label' | 'rule'; index: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState(8);
  const waste = model.waste; const locked = busy || pendingRead;
  const execute = async (work: () => Promise<unknown>) => {
    if (working.current || locked) throw new Error('保存または再読込が終わってから、もう一度お試しください。');
    working.current = true; setError(null);
    try {
      const outcome = await perform(work);
      if (!outcome.committed) throw outcome.error instanceof Error ? outcome.error : new Error('収集日を保存できませんでした。');
      setPendingRead(!outcome.refreshed); setForm({ key: ++nextKey.current }); setDeleting(null); setCandidate(null);
    } finally { working.current = false; }
  };
  const run = async (work: () => Promise<unknown>) => { try { await execute(work); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。'); } };
  const act = (work: () => Promise<unknown>) => void run(work);
  const rows = waste?.rows.filter(row => !row.deleted) ?? [];
  const upcoming = waste?.occurrences.filter(entry => entry.occurrence.date >= model.plan.range.asOfDate) ?? [];
  const hasConflict = form.row && Object.values(form.row.fields).some(field => field.kind === 'conflict');
  const headerContent = <View style={{ gap: 12, paddingBottom: 8 }}>{header}
        <Text style={styles.caption}>グループ全員に共有されます。</Text>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {pendingRead ? <Card><Text style={styles.body}>端末に保存済みです。再送せず、現在の収集日を読み直してください。</Text>
          <AppButton title="保存済みの収集日を再読込" disabled={busy} onPress={() => {
            if (working.current) return; working.current = true;
            void perform(async () => {}).then(result => { setPendingRead(!result.refreshed); }).finally(() => { working.current = false; });
          }} /></Card> : null}
        {!waste ? <Card><Text style={styles.body}>共有の収集日を取得できませんでした。</Text>
          <AppButton title="収集日を再読込" disabled={busy} onPress={() => void perform(async () => {})} /></Card> : null}
        {waste ? <View style={{ gap: 10 }}>
          {hasConflict ? <Text style={styles.error}>名前と収集ルールを確認し、入力した内容で表示中の競合を解決して、この収集日を残します。</Text> : null}
          <WasteScheduleEditor key={form.key} referenceDate={model.plan.range.asOfDate} disabled={locked}
            initial={form.row ? initialForm(form.row) : undefined}
            onCancel={form.row ? () => setForm({ key: ++nextKey.current }) : undefined} onSubmit={input => execute(() => form.row ? form.row.fields.presence.kind === 'conflict'
              ? actions.resolveWastePresence(form.row.id, form.row.revision, true, input) : actions.editWasteSchedule(form.row.id, formEdits(form.row, input)) : actions.addWasteSchedule(input))} />
        </View> : null}
        {waste ? <WasteRegistrationHeading count={rows.length} /> : null}
      </View>;
  const renderItem = ({ item: row }: { item: V2WasteRow }) => <WasteSettingsItem key={row.id}><View style={styles.scheduleRow}><View style={styles.copy}>
        <View style={styles.nameRow}><WasteTypeIcon label={row.label} size={20} /><Text style={[styles.name, { color: wasteTypeColor(row.label) }]}>{row.label}</Text></View>
        {row.fields.presence.kind !== 'conflict' ? <Text style={styles.caption}>{row.needsReview ? '確認が必要です。収集日は確定するまで表示されません。' : ruleSummary(row.fields.rule.value)}</Text> : null}
        </View>{row.fields.presence.kind !== 'conflict' ? <View style={styles.actions}>
          <WasteSettingsAction title={row.needsReview ? '確認・修正' : '編集'} accessibilityLabel={`「${row.label}」の共有収集日を編集`} disabled={locked}
            onPress={() => { setError(null); setForm({ row, key: ++nextKey.current }); }} />
          <WasteSettingsAction title="削除" accessibilityLabel={`「${row.label}」の共有収集日を削除`} danger disabled={locked} onPress={() => setDeleting(row)} />
        </View> : null}</View>
        {row.fields.presence.kind === 'conflict' ? <><Text style={styles.error}>削除と編集が重なっています。この収集日を残すか選んでください。</Text>
          <AppButton title={`「${row.label}」を残す内容を確認`} compact variant="quiet" disabled={locked} onPress={() => { setError(null); setForm({ row, key: ++nextKey.current }); }} />
          <AppButton title={`「${row.label}」の削除を確定`} compact variant="quiet" disabled={locked} onPress={() => act(() => actions.resolveWastePresence(row.id, row.revision, false))} /></>
          : <>
            {(['label', 'rule'] as const).map(field => row.fields[field].kind === 'conflict' ? <View key={field} style={{ gap: 8 }}>
              <Text style={styles.body}>{field === 'label' ? '名前' : '収集ルール'}の候補</Text>
              {row.fields[field].candidates.map((source, index) => {
                const open = candidate?.id === row.id && candidate.field === field && candidate.index === index;
                return <View key={source.operationId} style={{ gap: 6 }}>
                  <AppButton title={`候補${index + 1}を確認`} accessibilityLabel={`${row.id}の${field}の候補${index + 1}を確認`} compact variant="quiet" disabled={locked}
                    onPress={() => setCandidate(open ? null : { id: row.id, field, index })} />
                  {open ? <><Text style={styles.body}>{field === 'rule' ? ruleSummary(source.value) : String(source.value)}</Text>
                    {source.value !== null ? <AppButton title={`候補${index + 1}で${field === 'label' ? '名前' : '収集ルール'}を解決`} compact disabled={locked} onPress={() => act(() => actions.editWasteSchedule(row.id,
                      [{ field, value: source.value, basisOperationIds: sourceIds(row.fields[field]), resolveOperationIds: sourceIds(row.fields[field]) }]))} /> : null}</> : null}
                </View>;
              })}
            </View> : null)}
          </>}
        {deleting?.id === row.id ? <View style={{ gap: 8 }}><Text style={styles.body}>この収集日をグループ全員の予定から削除します。操作履歴は残ります。</Text>
          <AppButton title="この共有収集日を削除する" disabled={locked} onPress={() => act(() => actions.deleteWasteSchedule(deleting.id, deleting.revision))} />
          <AppButton title="削除をやめる" compact variant="quiet" disabled={locked} onPress={() => setDeleting(null)} /></View> : null}
      </WasteSettingsItem>;
  const footer = waste && rows.length > 0 ? <SettingsGroup title="次の収集日">
        {upcoming.slice(0, 30).map(entry => <View key={entry.key} style={{ gap: 4 }}>
          <V2WasteOccurrence entry={entry} compact editing={{ busy: locked, actions, run }} />
        </View>)}
        {upcoming.length === 0 ? <Text style={styles.caption}>確定した収集日はありません。</Text> : null}
        {upcoming.length > 30 ? <Text style={styles.caption}>直近30件を表示しています。各日付はカレンダーでも確認できます。</Text> : null}
      </SettingsGroup> : undefined;
  if (embedded) return <View>{headerContent}{rows.slice(0, visibleCount).map(row => renderItem({ item: row }))}
    {rows.length > visibleCount ? <WasteSettingsAction title="収集日をさらに表示" onPress={() => setVisibleCount(count => count + 8)} /> : null}{footer}</View>;
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
    <NavigationHeader><SettingsHeader title="ゴミ収集日" onBack={onBack} backDisabled={busy} /></NavigationHeader>
    <FlatList data={rows} keyExtractor={row => row.id} initialNumToRender={8} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.page}
      ListHeaderComponent={headerContent} renderItem={renderItem} ListFooterComponent={footer} />
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({ page: { padding: 20, paddingTop: 14, gap: 0, paddingBottom: 40 }, body: { ...typography.body, color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, error: { ...typography.caption, color: palette.warning },
  name: { ...typography.label, fontWeight: '600', flexShrink: 1 }, nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scheduleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, copy: { flex: 1, minWidth: 120, gap: 4 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
