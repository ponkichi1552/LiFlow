import { useState } from 'react';
import moment from 'moment-timezone';
import { Text, View } from 'react-native';
import { AppButton } from '../../../components/planner-ui';
import { AccordionSection } from '../../../components/accordion-section';
import { isSharedTimeZone } from '../group-clock';
import type { V2GroupScreenModel } from '../v2/controller';
import type { useV2FieldAutosave } from './use-field-autosave';
import type { V2FieldCodec } from './field-editor-state';
import { V2Choices, V2TextField, v2FormStyles as styles } from './form-controls';

export const groupNameCodec: V2FieldCodec = { format: value => typeof value === 'string' ? value : '', parse: raw => {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 500) throw new Error('グループ名は1〜500文字で入力してください。');
  return raw.trim();
} };
export const groupRegionCodec: V2FieldCodec = { format: value => typeof value === 'string' ? value : '', parse: raw => {
  if (!isSharedTimeZone(raw)) throw new Error('候補からグループの地域を選んでください。'); return raw;
} };
const aliases: Record<string, string> = { 'Asia/Tokyo': '東京・日本', 'UTC': 'UTC', 'America/New_York': 'ニューヨーク',
  'America/Los_Angeles': 'ロサンゼルス', 'Europe/London': 'ロンドン', 'Europe/Paris': 'パリ', 'Asia/Seoul': 'ソウル',
  'Australia/Sydney': 'シドニー', 'Pacific/Honolulu': 'ホノルル', 'Pacific/Kiritimati': 'キリティマティ' };
const label = (value: string) => aliases[value] && aliases[value] !== value ? `${aliases[value]}（${value}）` : value;
const zones = moment.tz.names();
export function v2RegionChoices(query: string, current: string) {
  const term = query.trim().toLowerCase();
  const matches = term ? zones.filter(zone => `${zone} ${aliases[zone] ?? ''}`.toLowerCase().includes(term))
    : [...new Set([current, 'Asia/Tokyo', 'UTC', 'America/New_York'])].filter(isSharedTimeZone);
  return { total: matches.length, choices: matches.slice(0, 8).map(value => ({ value, label: label(value) })) };
}

/** Search is local and never a shared edit. Only choosing a region enters the existing autosave queue. */
export function V2GroupSettingsFields({ autosave, model, admin }: {
  autosave: ReturnType<typeof useV2FieldAutosave>; model: V2GroupScreenModel; admin: boolean;
}) {
  const [search, setSearch] = useState(''); const current = String(autosave.raw.timeZone ?? ''); const found = v2RegionChoices(search, current);
  const [regionOpen, setRegionOpen] = useState(false);
  return <View style={styles.group}>
    {(['name', 'timeZone'] as const).map(field => {
      const source = autosave.fields[field]; const title = field === 'name' ? 'グループ名' : '地域';
      if (source.kind === 'conflict') return <View key={field} style={styles.group}>
        <Text style={styles.error}>{title}が競合しています。候補を確認して選んでください。</Text>
        {source.candidates.map((candidate, index) => <View key={candidate.operationId} style={styles.group}>
          <Text style={styles.body}>{title}の候補{index + 1}：{String(candidate.value)}</Text>
          {admin ? <AppButton title={`${title}の候補${index + 1}で解決する`} variant="secondary" disabled={autosave.leaving}
            onPress={() => autosave.resolve(field, candidate.value)} /> : null}
        </View>)}
      </View>;
      if (field === 'name') return admin ? <V2TextField filled key={field} label="グループ名" value={String(autosave.raw.name ?? '')}
        editable={!autosave.leaving} onChangeText={raw => autosave.change('name', raw)} />
        : <Text key={field} style={styles.body}>グループ名：{String(source.kind === 'value' ? source.value : '未設定')}</Text>;
      return <AccordionSection listRow key={field} title="地域" summary={(aliases[current] ?? current) || '未設定'} expanded={regionOpen} onToggle={() => setRegionOpen(value => !value)}>
        <Text style={styles.caption}>変更後に指定する日時から適用します。</Text>
        {admin ? <><V2TextField filled label="地域を検索" value={search} onChangeText={setSearch} editable={!autosave.leaving} placeholder="東京、ニューヨーク、Asia/Tokyo" />
          <V2Choices label="グループの地域" choices={found.choices} value={current} disabled={autosave.leaving} onChange={value => autosave.change('timeZone', value)} />
          {!found.total ? <Text style={styles.caption}>一致する地域がありません。都市名または地域IDで検索してください。</Text>
            : found.total > 8 ? <Text style={styles.caption}>{found.total}件のうち8件を表示しています。入力を追加すると絞り込めます。</Text> : null}
        </> : null}
      </AccordionSection>;
    })}
    {Object.entries(autosave.errors).filter(([field]) => field !== 'configuration').map(([field, error]) => <Text key={field} accessibilityRole="alert" style={styles.error}>{error}</Text>)}
    {!model.plan.initialized ? <Text style={styles.caption}>地域またはルールの競合を解決するまで、日時の指定・承認は停止しています。</Text> : null}
  </View>;
}
