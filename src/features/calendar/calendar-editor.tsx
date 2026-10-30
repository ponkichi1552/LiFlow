import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { AppButton, ChoiceChip, palette, typography } from '../../components/planner-ui';
import { FormTextInput } from '../../components/form-text-input';
import { SettingsSwitch } from '../../components/settings-switch';
import { Chevron } from '../../components/chevron';
import { addDays, daysBetween } from '../../domain/scheduling/local-date';
import { CATEGORY_PRESETS, categoryColor, RECURRENCE_LABELS, recurrenceLabel } from './events';
import type { CalendarRecurrence, EventDraft } from './events';
import { createCalendarGesture } from './gesture-control';
import { CalendarField } from './calendar-field';
import type { LocalCalendarBinding } from './use-local-calendar';
import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';
import { calendarDraftKey, deleteCalendarEvent, saveCalendarCategory, saveCalendarDraft, saveCalendarEvent } from '../../platform/storage/calendar-events';
import { CalendarOptionPicker } from './calendar-option-picker';

export interface ExistingCalendarChore { id: string; name: string; minutes?: number; onOpen: () => void }
export function CalendarEditor({ initial, local, chores = [], onClose, onSaved, repeatReturnTo = 'personal' }: {
  initial: CalendarEditorDraft; local: LocalCalendarBinding; chores?: readonly ExistingCalendarChore[]; onClose: () => void; onSaved: (date: EventDraft['startDate']) => void;
  repeatReturnTo?: 'personal' | 'group';
}) {
  const [draft, setDraft] = useState(initial); const latest = useRef(draft);
  useLayoutEffect(() => { latest.current = draft; }, [draft]);
  const [busy, setBusy] = useState(false); const lock = useRef(false); const scrollTop = useRef(0);
  const [modalRevision, setModalRevision] = useState(0);
  const [error, setError] = useState<string | null>(null); const [repeatOpen, setRepeatOpen] = useState(false); const [categoryOpen, setCategoryOpen] = useState(false); const scheme = useColorScheme();
  const [categoryEdit, setCategoryEdit] = useState<{ id?: string; revision: number; name: string; color: string } | null>(null);
  const [custom, setCustom] = useState(false); const [rgb, setRgb] = useState(['52', '141', '194']);
  const original = local.snapshot.events.find(event => event.id === initial.eventId);
  const repeated = original && original.recurrence !== 'none'; const value = draft.value;
  const change = (fn: (before: CalendarEditorDraft) => CalendarEditorDraft) => { const next = fn(latest.current); latest.current = next; setDraft(next); };
  const patch = (patch: Partial<EventDraft>) => change(before => ({ ...before, value: { ...before.value, ...patch } }));
  const work = async (task: () => Promise<void>) => {
    if (lock.current) return false; lock.current = true; setBusy(true); setError(null);
    try { await task(); return true; } catch (cause) { setError(cause instanceof Error ? cause.message : '保存できませんでした。もう一度お試しください。'); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  const close = (nativeDismissed = false) => void work(async () => {
    if (local.database && JSON.stringify(latest.current) !== JSON.stringify(initial)) await saveCalendarDraft(local.database, latest.current);
    onClose();
  }).then(ok => {
    // iOS calls onRequestClose after an interactive dismissal. Reopen with the
    // intact draft if persistence failed rather than leaving an invisible editor.
    if (!ok && nativeDismissed) setModalRevision(v => v + 1);
  });
  const save = (resetExceptions = false) => void work(async () => {
    if (!local.database) throw new Error('予定の保存先を読み込んでください。');
    const d = latest.current;
    await saveCalendarEvent(local.database, { id: d.eventId ?? undefined, expectedRevision: d.revision, value: d.value,
      scope: d.scope, anchorDate: d.anchorDate ?? undefined, expectedExceptionRevision: d.exceptionRevision, resetExceptions });
    await local.refresh(); onSaved(d.value.startDate);
  });
  const saveReviewed = () => {
    const d = latest.current;
    const resets = original && d.scope === 'series' && (d.value.startDate !== original.startDate || d.value.recurrence !== original.recurrence || d.value.untilDate !== original.untilDate || JSON.stringify(d.value.customRecurrence) !== JSON.stringify(original.customRecurrence))
      && local.snapshot.exceptions.some(row => row.eventId === original.id);
    if (resets) Alert.alert('繰り返し全体を変更', 'この予定の個別に変更した回をリセットして、繰り返しを変更しますか？', [
      { text: 'キャンセル', style: 'cancel' }, { text: '変更する', onPress: () => save(true) },
    ]); else save();
  };
  const remove = () => Alert.alert(draft.scope === 'one' && repeated ? 'この回を削除' : '予定を削除', 'この予定を削除しますか？', [
    { text: 'キャンセル', style: 'cancel' }, { text: '削除', style: 'destructive', onPress: () => void work(async () => {
      if (!local.database || !initial.eventId) return; const d = latest.current;
      await deleteCalendarEvent(local.database, { id: initial.eventId, expectedRevision: d.revision,
        anchorDate: repeated && d.scope === 'one' ? d.anchorDate ?? undefined : undefined, expectedExceptionRevision: d.exceptionRevision });
      await local.refresh(); onClose();
    }) },
  ]);
  const pull = useMemo(() => createCalendarGesture(), []);
  useLayoutEffect(() => { pull.update({ canStart: gesture => Platform.OS === 'android' && !lock.current && scrollTop.current <= 0 && gesture.dy > 18 && gesture.dy > Math.abs(gesture.dx) * 1.5,
    release: gesture => { if (gesture.dy > 85) close(); } }); });
  const selectedCategory = local.snapshot.categories.find(row => row.id === value.categoryId);
  const matches = value.title.trim() ? chores.filter(chore => chore.name.includes(value.title.trim()) || value.title.trim().includes(chore.name)).slice(0, 4) : [];
  const textKey = `${draft.scope}:${initial.eventId ?? 'new'}:${initial.anchorDate ?? ''}`;
  const openCustomRecurrence = () => void work(async () => {
    if (!local.database) throw new Error('入力内容の保存先を確認してください。');
    await saveCalendarDraft(local.database, latest.current);
    const key = calendarDraftKey(latest.current); onClose();
    router.push({ pathname: '/calendar-repeat', params: { draft: key, returnTo: repeatReturnTo } });
  });
  return <Modal key={modalRevision} visible animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'overFullScreen'} transparent={Platform.OS === 'android'}
    allowSwipeDismissal={!busy} onRequestClose={() => close(Platform.OS === 'ios')}>
    <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.sheet, Platform.OS === 'android' && styles.androidSheet]} {...pull.panHandlers}>
        <View style={styles.grabber} /><View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel="予定の編集を閉じる" disabled={busy} onPress={() => close()} style={styles.headerButton}><Text style={styles.action}>閉じる</Text></Pressable>
          <Text numberOfLines={1} adjustsFontSizeToFit style={styles.heading}>{initial.eventId ? '予定を編集' : value.birthday ? '誕生日を追加' : '予定を追加'}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="予定を保存" disabled={busy} onPress={saveReviewed} style={[styles.headerButton, styles.headerSave]}><Text style={[styles.action, busy && { opacity: .45 }]}>{busy ? '保存中' : '保存'}</Text></Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets keyboardDismissMode="on-drag" scrollEventThrottle={16}
          onScroll={event => { scrollTop.current = event.nativeEvent.contentOffset.y; }} contentContainerStyle={styles.body}>
          {error ? <View><Text accessibilityRole="alert" style={styles.error}>{error}</Text><AppButton title="予定を再読込" variant="quiet" compact onPress={() => void local.refresh()} /></View> : null}
          {repeated ? <View style={styles.row}>{(['one', 'series'] as const).map(scope => <ChoiceChip key={scope} label={scope === 'one' ? '今回だけ' : '繰り返し全体'} selected={draft.scope === scope} disabled={busy}
            onPress={() => change(before => {
              const basis = before.scope === 'series' ? original : initial.value; const next = { ...(scope === 'series' ? original : initial.value) };
              for (const key of Object.keys(initial.value) as (keyof EventDraft)[]) if (before.value[key] !== basis[key]) Object.assign(next, { [key]: before.value[key] });
              return { ...before, scope, value: next };
            })} />)}</View> : null}
          <View style={styles.inputGroup}>
          {/* Native text stays authoritative while typing; JS still captures every change for saving. */}
          <FormTextInput key={`${textKey}:title`} accessibilityLabel="予定名" defaultValue={value.title} placeholder={value.birthday ? '名前・誕生日' : '予定名・家事名'} style={[styles.textInput, styles.titleInput]} maxLength={160} editable={!busy} onChangeText={title => patch({ title })} />
          {matches.length && !value.birthday && !initial.eventId ? <View style={styles.existing}><Text style={styles.label}>登録済みの家事</Text>{matches.map(chore => <Pressable key={chore.id} accessibilityRole="button" accessibilityLabel={`${chore.name}の既存の予定を開く`} onPress={() => { onClose(); chore.onOpen(); }} style={styles.existingRow}>
            <Text style={styles.value}>{chore.name}{chore.minutes ? ` · 約${chore.minutes}分` : ''}</Text><Chevron /></Pressable>)}<Text style={styles.caption}>家事を選ぶと、登録済みの家事回が開きます。</Text></View> : null}
          {!value.birthday ? <FormTextInput key={`${textKey}:location`} accessibilityLabel="予定の場所" defaultValue={value.location} style={styles.textInput} maxLength={300} placeholder="場所（任意）" editable={!busy} onChangeText={location => patch({ location })} /> : null}
          <FormTextInput key={`${textKey}:notes`} accessibilityLabel="予定のメモ" multiline defaultValue={value.notes} style={[styles.textInput, styles.notesInput]} maxLength={4000} placeholder="メモ（任意）" editable={!busy} onChangeText={notes => patch({ notes })} />
          </View>
          {!value.birthday ? <View style={styles.switchRow}><Text style={styles.value}>終日</Text><SettingsSwitch accessibilityLabel="終日" value={value.allDay} disabled={busy} onValueChange={allDay => patch({ allDay })} /></View> : null}
          <View style={styles.field}><Text style={styles.label}>{value.birthday ? '誕生日' : '開始'}</Text><View style={styles.row}><CalendarField hideLabel disabled={busy} label={value.birthday ? '誕生日' : '開始日'} date={value.startDate} minute={value.startMinute} mode="date" onDate={date => {
            const span = daysBetween(latest.current.value.startDate, latest.current.value.endDate); patch({ startDate: date, endDate: addDays(date, span) });
          }} />{!value.allDay ? <CalendarField hideLabel disabled={busy} label="開始" date={value.startDate} minute={value.startMinute} mode="time" onMinute={startMinute => patch({ startMinute })} /> : null}</View></View>
          {!value.birthday ? <View style={styles.field}><Text style={styles.label}>終了</Text><View style={styles.row}>
            <CalendarField hideLabel disabled={busy} label="終了日" date={value.endDate} minute={value.endMinute} mode="date" onDate={endDate => patch({ endDate })} />
            {!value.allDay ? <CalendarField hideLabel disabled={busy} label="終了" date={value.endDate} minute={value.endMinute} mode="time" onMinute={endMinute => patch({ endMinute })} /> : null}
          </View></View> : null}
          <Text style={styles.caption}>地域：{value.timeZone}</Text>
          {!value.birthday && (!repeated || draft.scope === 'series') ? <View style={styles.field}><Text style={styles.label}>繰り返し</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="繰り返しを選択" accessibilityValue={{ text: recurrenceLabel(value) }} accessibilityState={{ expanded: repeatOpen }} disabled={busy} onPress={() => setRepeatOpen(true)} style={styles.select}><Text style={styles.value}>{recurrenceLabel(value)}</Text><Chevron direction="down" /></Pressable>
            {value.recurrence !== 'none' ? <><View style={styles.switchRow}><Text style={styles.value}>繰り返しの終了日</Text><SettingsSwitch disabled={busy} accessibilityLabel="繰り返しに終了日を設定" value={value.untilDate !== null} onValueChange={on => patch({ untilDate: on ? addDays(value.startDate, 365) : null })} /></View>
              {value.untilDate ? <CalendarField disabled={busy} label="繰り返しの終了日" date={value.untilDate} minute={0} mode="date" onDate={untilDate => patch({ untilDate })} /> : null}</> : null}
          </View> : null}
          <View style={styles.field}><Text style={styles.label}>分類</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="分類を選択" accessibilityValue={{ text: selectedCategory?.name ?? '未選択' }} accessibilityState={{ expanded: categoryOpen }} disabled={busy} onPress={() => setCategoryOpen(v => !v)} style={styles.select}>
              <View style={styles.categoryValue}>{selectedCategory ? <View style={[styles.swatchSmall, { backgroundColor: selectedCategory.color }]} /> : null}<Text style={styles.value}>{selectedCategory?.name ?? '分類を選択'}</Text></View><Chevron direction={categoryOpen ? 'up' : 'down'} />
            </Pressable>
            {categoryOpen ? <View style={styles.categoryMenu}><ScrollView nestedScrollEnabled style={styles.categoryOptions} keyboardShouldPersistTaps="handled">
              {local.snapshot.categories.map(category => <Pressable key={category.id} accessibilityRole="button" accessibilityLabel={`${category.name}の分類を選択`} accessibilityState={{ selected: category.id === value.categoryId }} disabled={busy}
                style={[styles.categoryOption, category.id === value.categoryId && { backgroundColor: palette.accentSoft }]} onPress={() => { patch({ categoryId: category.id }); setCategoryOpen(false); }}>
                <View style={[styles.swatchSmall, { backgroundColor: category.color }]} /><Text style={[styles.value, { flex: 1 }]}>{category.name}</Text>{category.id === value.categoryId ? <Text style={styles.action}>✓</Text> : null}</Pressable>)}
            </ScrollView><View style={styles.categoryActions}><AppButton title="分類を追加" variant="quiet" compact disabled={busy} onPress={() => { setCategoryOpen(false); setCategoryEdit({ revision: 0, name: '', color: CATEGORY_PRESETS[0] }); setCustom(false); }} />
              {selectedCategory ? <AppButton title="分類の色を編集" variant="quiet" compact disabled={busy} onPress={() => { setCategoryOpen(false); setCategoryEdit({ ...selectedCategory }); setCustom(false); }} /> : null}</View></View> : null}
          </View>
          {categoryEdit ? <View style={styles.colorPanel}><Text style={styles.heading}>{categoryEdit.id ? '分類の色' : '新しい分類'}</Text>
            <FormTextInput accessibilityLabel="分類名" value={categoryEdit.name} placeholder="例：学校" maxLength={40} onChangeText={name => setCategoryEdit(before => before && ({ ...before, name }))} />
            <View style={styles.wrap}>{CATEGORY_PRESETS.map(color => <Pressable key={color} accessibilityRole="button" accessibilityLabel={`色 ${color}`} accessibilityState={{ selected: categoryEdit.color === color }}
              style={[styles.swatch, { backgroundColor: color }, categoryEdit.color === color && styles.swatchSelected]} onPress={() => setCategoryEdit(before => before && ({ ...before, color }))} />)}</View>
            <Pressable accessibilityRole="button" onPress={() => { setCustom(v => !v); setRgb(categoryEdit.color.slice(1).match(/../g)!.map(v => String(parseInt(v, 16)))); }} style={styles.select}><Text style={styles.action}>カスタムカラー</Text><Chevron direction={custom ? 'up' : 'down'} /></Pressable>
            {custom ? <View style={styles.row}>{['R', 'G', 'B'].map((name, i) => <View key={name} style={styles.rgb}><Text style={styles.label}>{name}（0〜255）</Text><FormTextInput accessibilityLabel={`カラー${name}`} keyboardType="number-pad" value={rgb[i]} maxLength={3} onChangeText={text => {
              const next = rgb.map((v, n) => n === i ? text.replace(/[^0-9]/g, '') : v); setRgb(next);
              if (next.every(v => v !== '' && Number(v) <= 255)) setCategoryEdit(before => before && ({ ...before, color: '#' + next.map(v => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase() }));
            }} /></View>)}</View> : null}
            <View style={[styles.colorPreview, { borderColor: categoryColor(categoryEdit.color, scheme === 'dark') }]}><View style={[styles.swatchSmall, { backgroundColor: categoryEdit.color }]} /><Text style={styles.value}>{categoryEdit.name || 'プレビュー'} · {categoryEdit.color}</Text></View>
            <View style={styles.row}><AppButton title="閉じる" compact variant="quiet" onPress={() => setCategoryEdit(null)} />
              <AppButton title="分類を保存" compact variant="secondary" disabled={busy || custom && !rgb.every(v => v !== '' && Number(v) <= 255)} onPress={() => void work(async () => {
                if (!local.database) throw new Error('保存先を確認してください。');
                const id = await saveCalendarCategory(local.database, { id: categoryEdit.id, expectedRevision: categoryEdit.revision, name: categoryEdit.name, color: categoryEdit.color });
                await local.refresh(); patch({ categoryId: id }); setCategoryEdit(null);
              })} /></View>
          </View> : null}
          {initial.eventId ? <AppButton title={repeated && draft.scope === 'one' ? 'この回を削除' : '予定を削除'} variant="danger" disabled={busy} onPress={remove} /> : <AppButton title="入力を破棄" variant="quiet" disabled={busy} onPress={() => void work(async () => { if (local.database) await saveCalendarDraft(local.database, null, latest.current.value.birthday); onClose(); })} />}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
    {repeatOpen ? <CalendarOptionPicker title="繰り返し" value={value.recurrence} options={(Object.keys(RECURRENCE_LABELS) as CalendarRecurrence[]).map(recurrence => ({ value: recurrence, label: RECURRENCE_LABELS[recurrence] }))}
      onClose={() => setRepeatOpen(false)} onCustom={openCustomRecurrence} onSelect={recurrence => { if (recurrence !== 'custom' && Object.hasOwn(RECURRENCE_LABELS, recurrence)) patch({ recurrence: recurrence as CalendarRecurrence, customRecurrence: undefined }); }} /> : null}
  </Modal>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: palette.overlay }, sheet: { flex: 1, backgroundColor: palette.background }, androidSheet: { flex: 0, height: '92%', borderTopLeftRadius: 22, borderTopRightRadius: 22, overflow: 'hidden' },
  grabber: { width: 34, height: 4, borderRadius: 2, backgroundColor: palette.inputBorder, alignSelf: 'center', marginTop: 8, marginBottom: 3 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border, paddingHorizontal: 14, gap: 8, minHeight: 52 },
  headerButton: { minHeight: 44, justifyContent: 'center', width: 64 }, headerSave: { alignItems: 'flex-end' }, heading: { ...typography.subheading, color: palette.ink, fontWeight: '700', flex: 1, textAlign: 'center' },
  body: { padding: 18, paddingBottom: 40, gap: 18 }, field: { gap: 7 }, row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  inputGroup: { gap: 10 }, textInput: { borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 12, paddingHorizontal: 12, backgroundColor: palette.surface }, titleInput: { fontWeight: '600' }, notesInput: { minHeight: 70 },
  action: { ...typography.body, color: palette.accent }, label: { ...typography.caption, color: palette.muted }, value: { ...typography.body, color: palette.ink, flexShrink: 1 },
  caption: { ...typography.caption, color: palette.muted }, error: { ...typography.body, color: palette.warning }, switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 12, paddingHorizontal: 12, minHeight: 46 },
  categoryValue: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }, categoryMenu: { borderWidth: 1, borderColor: palette.border, borderRadius: 12, overflow: 'hidden' }, categoryOptions: { maxHeight: 220 }, categoryOption: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border }, categoryActions: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  swatchSmall: { width: 14, height: 14, borderRadius: 7, borderWidth: 1, borderColor: palette.inputBorder }, swatch: { width: 38, height: 38, borderRadius: 19, borderWidth: 2, borderColor: palette.border }, swatchSelected: { borderColor: palette.ink, borderWidth: 4 },
  colorPanel: { padding: 12, gap: 12, borderWidth: 1, borderColor: palette.border, borderRadius: 14 }, rgb: { flex: 1, gap: 4 }, colorPreview: { minHeight: 42, borderWidth: 2, borderRadius: 10, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  existing: { padding: 12, gap: 8, borderWidth: 1, borderColor: palette.border, borderRadius: 12 }, existingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
});
