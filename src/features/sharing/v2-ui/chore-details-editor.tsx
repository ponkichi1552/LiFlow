import { useState } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { AppButton, BackButton, Card, ScreenHeading, SectionHeading } from '../../../components/planner-ui';
import { AccordionSection } from '../../../components/accordion-section';
import type { JsonValue } from '../operations';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2ChoreDetailField, V2EditableField } from '../v2/field-edit';
import { V2FormScrollView, V2TextField, v2FormStyles as styles } from './form-controls';
import { useV2FieldAutosave } from './use-field-autosave';
import { v2ChoreDetailCodecs, v2DetailValueLabel } from './chore-detail-fields';
import type { V2SectionDraft } from './chore-detail-fields';
import { v2MemberLabels } from './member-labels';
import { V2AutosaveFeedback } from './autosave-feedback';
import { NumberInputField } from '../../../components/number-input-field';
import { SettingsAction } from '../../../components/settings-controls';

export function V2ChoreDetailsEditor(props: { model: V2GroupScreenModel; choreId: string; controller: V2GroupController;
  onSaved: () => Promise<void>; onBack: () => void; onConfiguration?: () => void; onDateRights?: () => void; header?: ReactNode; embedded?: boolean; unfolded?: boolean }) {
  const source = props.model.choreDetails.find((row) => row.choreId === props.choreId);
  if (!source) return <V2FormScrollView><View style={{ padding: 16, gap: 14 }}>{props.header}<BackButton onPress={props.onBack} />
    <Text style={styles.body}>この家事の編集情報を取得できませんでした。</Text><AppButton title="編集情報を再読込" variant="secondary" onPress={() => void props.onSaved().catch(() => undefined)} /></View></V2FormScrollView>;
  return <Details key={`${props.model.viewerUserId}:${props.model.plan.groupId}:${props.choreId}`} {...props} source={source} />;
}

function Details({ model, choreId, controller, source, onSaved, onBack, onConfiguration, onDateRights, header, embedded, unfolded }: Parameters<typeof V2ChoreDetailsEditor>[0] & {
  source: V2GroupScreenModel['choreDetails'][number];
}) {
  const autosave = useV2FieldAutosave({ fields: source.fields, codecs: v2ChoreDetailCodecs,
    save: (edits) => controller.actions.patchChoreDetails(choreId, edits), onSaved }, `details:${choreId}`);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [contentOpen, setContentOpen] = useState(false);
  const blocked = source.alive.kind !== 'value' || source.alive.value !== true;
  const disabled = blocked || autosave.leaving; const nameOf = v2MemberLabels(model.plan.members);
  const textValue = (field: V2ChoreDetailField) => typeof autosave.raw[field] === 'string' ? autosave.raw[field] as string : '';
  const fieldError = (field: V2ChoreDetailField) => autosave.errors[field] ? <Text accessibilityRole="alert" style={styles.error}>{autosave.errors[field]}</Text> : null;
  const conflict = (field: V2ChoreDetailField): V2EditableField | null => autosave.fields[field].kind === 'conflict' ? autosave.fields[field] : null;
  const choose = (field: V2ChoreDetailField, current: V2EditableField) => <View style={styles.group}>
    <Text style={styles.error}>別の変更が届いています。候補を開いて内容を確認してください。</Text>
    {current.candidates.map((candidate, index) => <AccordionSection key={candidate.operationId} title={`候補${index + 1} · ${nameOf(candidate.authorUserId)}`}
      expanded={expanded[candidate.operationId] === true} onToggle={() => setExpanded((value) => ({ ...value, [candidate.operationId]: !value[candidate.operationId] }))}>
      <Text style={styles.body}>{v2DetailValueLabel(candidate.value)}</Text>
      <AppButton title={`候補${index + 1}で解決する`} variant="secondary" disabled={disabled} onPress={() => autosave.resolve(field, candidate.value)} />
    </AccordionSection>)}
  </View>;
  const field = (key: V2ChoreDetailField, label: string, multiline = false, displayLabel?: string | false) => {
    const current = conflict(key); return <View style={styles.group}>{current ? choose(key, current) : <V2TextField label={label} value={textValue(key)} multiline={multiline}
      displayLabel={displayLabel} filled={unfolded} placeholder={multiline && unfolded ? key === 'description' ? '説明を追加' : key === 'instructions' ? '1行に1手順' : '1行に1項目' : undefined}
      maxLength={key === 'name' ? 500 : undefined} editable={!disabled} onChangeText={(value) => autosave.change(key, value)} onEndEditing={() => void autosave.flush()} />}{fieldError(key)}</View>;
  };
  const sections = Array.isArray(autosave.raw.procedureSections) ? autosave.raw.procedureSections as unknown as V2SectionDraft[] : [];
  const updateSection = (index: number, patch: Partial<V2SectionDraft>) => autosave.changeWith('procedureSections', (value) => (value as unknown as V2SectionDraft[])
    .map((section, position) => position === index ? { ...section, ...patch } : section) as unknown as JsonValue);
  const panel = (key: string, title: string, children: ReactNode) => {
    if (unfolded) return <View style={{ gap: 8 }}><Text style={styles.label}>{title}</Text>{children}</View>;
    const fields = (key === 'procedures' ? ['instructions', 'procedureSections'] : [key]) as V2ChoreDetailField[];
    const needsReview = fields.some(field => autosave.errors[field] || conflict(field));
    return <AccordionSection plain={embedded} title={title} expanded={expanded[key] === true || needsReview}
      onToggle={() => setExpanded(value => ({ ...value, [key]: !value[key] }))}>{children}</AccordionSection>;
  };
  const editorFields = <>
    {blocked ? <Text accessibilityRole="alert" style={styles.error}>家事の削除・復元の確認が必要です。入力は保持しています。</Text> : null}
    {unfolded ? field('name', '共有家事の名前', false, '家事名') : <Card>{field('name', '共有家事の名前')}</Card>}
    {model.plan.chores.find(chore => chore.id === choreId)?.category === '追加した家事' ? <View style={styles.group}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={styles.label}>目安時間</Text><NumberInputField suffix="分" accessibilityLabel="共有家事の目安時間" value={textValue('estimatedMinutes')} editable={!disabled && model.viewerUserId === model.adminUserId}
        onChangeText={value => autosave.change('estimatedMinutes', value)} onEndEditing={() => void autosave.flush()} />
      </View>{conflict('estimatedMinutes') ? choose('estimatedMinutes', autosave.fields.estimatedMinutes) : null}{fieldError('estimatedMinutes')}
    </View> : null}
    {panel('description', '説明', field('description', '共有家事の説明', true, unfolded ? false : undefined))}
    {panel('procedures', '家事の手順', <View style={styles.group}>
      {unfolded && sections.length === 0 && !conflict('procedureSections') ? field('instructions', '区分がないときの手順（1行に1手順）', true, false) : null}
      {!unfolded ? <SectionHeading title="区分ごとの手順" level="subsection" /> : null}
      {conflict('procedureSections') ? choose('procedureSections', autosave.fields.procedureSections) : <>
        {sections.map((section, index) => <View key={index} style={unfolded ? { gap: 8, paddingVertical: 6 } : undefined}>
          <V2TextField label={`手順の区分${index + 1}の見出し`} filled={unfolded} displayLabel={unfolded ? `見出し${index + 1}` : undefined} placeholder={unfolded ? '例：洗う' : undefined} value={section.title} editable={!disabled}
            onChangeText={(title) => updateSection(index, { title })} onEndEditing={() => void autosave.flush()} />
          <V2TextField label={`手順の区分${index + 1}（1行に1手順）`} filled={unfolded} displayLabel={unfolded ? false : undefined} placeholder={unfolded ? '1行に1手順' : undefined} value={section.text} multiline editable={!disabled}
            onChangeText={(text) => updateSection(index, { text })} onEndEditing={() => void autosave.flush()} />
          <View style={unfolded ? { alignSelf: 'flex-end' } : undefined}><AppButton title={unfolded ? '見出しを削除' : `区分${index + 1}を削除`} accessibilityLabel={`区分${index + 1}を削除`} compact variant={unfolded ? 'secondary' : 'quiet'} disabled={disabled} onPress={() => autosave.changeWith('procedureSections',
            (value) => (value as unknown as V2SectionDraft[]).filter((_, position) => position !== index) as unknown as JsonValue)} /></View>
        </View>)}
        <View style={unfolded ? { alignSelf: 'flex-start', paddingTop: 4 } : undefined}><SettingsAction title={unfolded ? '手順に見出しを追加' : '手順の区分を追加'} accessibilityLabel="手順の区分を追加" placement="page" compact disabled={disabled} onPress={() => autosave.changeWith('procedureSections',
          (value) => [...value as JsonValue[], { title: '', text: '' }])} /></View>
      </>}
      {fieldError('procedureSections')}
      {!unfolded ? <Text style={styles.caption}>区分があるときは、区分ごとの手順を表示します。</Text> : null}
      {!unfolded || sections.length > 0 || conflict('procedureSections') ? field('instructions', '区分がないときの手順（1行に1手順）', true, unfolded ? '見出しを使わない場合の手順' : undefined) : null}
    </View>)}
    {panel('tools', '使う道具', field('tools', '道具（1行に1項目）', true, unfolded ? false : undefined))}
    {panel('cautions', '注意点', field('cautions', '注意点（1行に1項目）', true, unfolded ? false : undefined))}
  </>;
  const feedback = <V2AutosaveFeedback concise={embedded} status={autosave.status} refreshError={autosave.refreshError} hasDraft={autosave.hasDraft()} flush={autosave.flush}
    discard={autosave.discard} discardTitle="入力を最新の内容に戻す" disabled={autosave.leaving} />;
  if (embedded) {
    if (unfolded) return <View style={{ gap: 16 }}>{header}<SectionHeading title="名前・手順の編集" level="subsection" />{editorFields}{feedback}</View>;
    const needsReview = blocked || autosave.status.phase === 'error' || Object.keys(autosave.errors).length > 0 || Object.values(autosave.fields).some(field => field.kind === 'conflict');
    return <View style={{ gap: 4 }}>{header}<AccordionSection plain title="名前・手順の編集" expanded={contentOpen || needsReview}
      onToggle={() => setContentOpen(value => !value)}>{editorFields}</AccordionSection>{feedback}</View>;
  }
  return <V2FormScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }} header={<BackButton disabled={autosave.leaving} onPress={() => void autosave.navigateAfterSave(onBack)} />}>{header}
    <ScreenHeading title="家事名・手順の編集" /><Text style={styles.caption}>この内容はグループ全員に公開されます。</Text>
    {editorFields}{feedback}
    {onConfiguration && model.viewerUserId === model.adminUserId ? <AppButton title="周期・担当の設定へ" variant="secondary" disabled={disabled}
      onPress={() => void autosave.navigateAfterSave(onConfiguration)} /> : null}
    {onDateRights && model.viewerUserId === model.adminUserId ? <AppButton title="日時変更の権限へ" variant="secondary" disabled={disabled}
      onPress={() => void autosave.navigateAfterSave(onDateRights)} /> : null}
  </V2FormScrollView>;
}
