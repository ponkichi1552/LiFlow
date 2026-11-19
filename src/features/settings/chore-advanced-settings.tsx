import { useState } from 'react';
import { router } from 'expo-router';
import { Text, View, StyleSheet, useColorScheme } from 'react-native';
import { Page, typography } from '../../components/planner-ui';
import { SettingsHeader } from '../../components/settings-header';
import { SettingsAction, SettingsPanel, SettingsSegments } from '../../components/settings-controls';
import { NumberInputField } from '../../components/number-input-field';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { CalendarField } from '../calendar/calendar-field';
import { V2TextField } from '../sharing/v2-ui/form-controls';
import { useV2DraftLifecycle } from '../sharing/v2-ui/use-draft-lifecycle';
import { createChoreAdvancedEditor } from './chore-advanced-editor';
import type { ChoreDefinition } from '../../domain/chores/types';
import type { LocalDate } from '../../domain/shared/types';
import type { PersonalChoreSettingsPatch } from '../../domain/chores/personal-settings-patch';

export function ChoreAdvancedSettings({ chore, today, save }: { chore: ChoreDefinition; today: LocalDate; save(patch: PersonalChoreSettingsPatch): Promise<void> }) {
  const [editor] = useState(() => createChoreAdvancedEditor(chore, today, save));
  const { snapshot, navigateAfterSave } = useV2DraftLifecycle(editor);
  const colors = plannerColorsForScheme(useColorScheme()); const { raw, errors, status } = snapshot;
  const row = [styles.row, { borderBottomColor: colors.border }];
  const changeSection = (index: number, patch: { title?: string; text?: string }) => editor.changeSections(raw.sections.map((section, position) => position === index ? { ...section, ...patch } : section));
  return <Page keyboardAware header={<SettingsHeader title="詳細設定" onBack={() => void navigateAfterSave(() => router.back())} />} contentStyle={styles.page}>
    <Text style={[typography.section, { color: colors.ink }]}>{chore.name}</Text>
    {chore.personalSchedulingKind !== 'seasonal' ? <View style={styles.section}>
      <Text style={[typography.label, { color: colors.ink }]}>日付</Text>
      <SettingsPanel>
        <View style={row}><Text style={[typography.body, { color: colors.ink }]}>開始日</Text>
          <CalendarField borderless hideLabel commitOnDone label="個人家事の開始日" mode="date" minute={0} date={raw.startDate} onDate={startDate => editor.changeSchedule({ startDate })} />
        </View>
        <View style={row}><Text style={[typography.body, { color: colors.ink }]}>周期</Text>
          <View style={{ minWidth: 146, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
            <SettingsSegments compact options={chore.personalSchedule?.once
              ? [{ id: 'once', label: '1回限り' }, { id: 'interval', label: '日数' }, { id: 'monthly', label: '毎月' }]
              : [{ id: 'interval', label: '日数' }, { id: 'monthly', label: '毎月' }]} value={raw.once ? 'once' : raw.monthly ? 'monthly' : 'interval'}
              onValueChange={value => editor.changeSchedule({ once: value === 'once', monthly: value === 'monthly' })} />
            {raw.monthly ? <NumberInputField borderless accessibilityLabel="個人家事の毎月の日付" value={raw.monthlyDay} onChangeText={monthlyDay => editor.changeSchedule({ monthlyDay })} onEndEditing={() => void editor.flush()} /> : null}
          </View>
        </View>
        {raw.monthly && Number(raw.monthlyDay) > 28 ? <Text style={[typography.caption, { color: colors.muted }]}>日付のない月は月末になります。</Text> : null}
        {errors.personalScheduleStartDate || errors.personalScheduleCadence ? <Text accessibilityRole="alert" style={[typography.caption, { color: colors.warning }]}>{errors.personalScheduleStartDate ?? errors.personalScheduleCadence}</Text> : null}
      </SettingsPanel>
    </View> : null}
    <View style={styles.section}><Text style={[typography.label, { color: colors.ink }]}>名前・手順の編集</Text>
      {(['name', 'description'] as const).map(field => <V2TextField key={field} label={field === 'name' ? '家事名' : '説明'} value={raw[field]}
        multiline={field !== 'name'} maxLength={field === 'name' ? 500 : 20000} onChangeText={value => editor.changeText(field, value)} onEndEditing={() => void editor.flush()} />)}
      <Text style={[typography.label, { color: colors.ink }]}>家事の手順</Text>
      {raw.sections.length ? raw.sections.map((section, index) => <View key={index} style={styles.section}>
        <V2TextField label={`見出し${index + 1}`} value={section.title} onChangeText={title => changeSection(index, { title })} onEndEditing={() => void editor.flush()} />
        <V2TextField label={`見出し${index + 1}の手順`} displayLabel={false} multiline placeholder="1行に1手順" value={section.text} onChangeText={text => changeSection(index, { text })} onEndEditing={() => void editor.flush()} />
        <View style={{ alignSelf: 'flex-end' }}><SettingsAction placement="page" compact title="見出しを削除" accessibilityLabel={`見出し${index + 1}を削除`} onPress={() => editor.changeSections(raw.sections.filter((_, position) => position !== index))} /></View>
      </View>) : null}
      <V2TextField label={raw.sections.length ? '見出しを使わない場合の手順' : '手順'} displayLabel={raw.sections.length ? undefined : false} placeholder="1行に1手順" multiline value={raw.instructions}
        onChangeText={value => editor.changeText('instructions', value)} onEndEditing={() => void editor.flush()} />
      <View style={{ alignSelf: 'flex-start' }}><SettingsAction placement="page" compact title="手順に見出しを追加" onPress={() => editor.changeSections([...raw.sections, { title: '', text: '' }])} /></View>
      {(['tools', 'cautions'] as const).map(field => <V2TextField key={field} label={field === 'tools' ? '使う道具' : '注意点'} multiline placeholder="1行に1項目" value={raw[field]}
        onChangeText={value => editor.changeText(field, value)} onEndEditing={() => void editor.flush()} />)}
      {Object.entries(errors).filter(([key]) => key !== 'personalScheduleStartDate' && key !== 'personalScheduleCadence').map(([key, error]) => <Text key={key} accessibilityRole="alert" style={[typography.caption, { color: colors.warning }]}>{error}</Text>)}
    </View>
    {status.error ? <Text accessibilityRole="alert" style={[typography.caption, { color: colors.warning }]}>{status.error}</Text> : null}
    {status.phase === 'error' ? <SettingsAction placement="page" title="保存を再試行" onPress={() => void editor.flush()} /> : null}
  </Page>;
}
const styles = StyleSheet.create({ page: { gap: 20 }, section: { gap: 12 }, row: { minHeight: 58, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: 1 } });
