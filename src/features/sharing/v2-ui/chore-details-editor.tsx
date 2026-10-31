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

export function V2ChoreDetailsEditor(props: { model: V2GroupScreenModel; choreId: string; controller: V2GroupController;
  onSaved: () => Promise<void>; onBack: () => void; onConfiguration?: () => void; onDateRights?: () => void; header?: ReactNode; embedded?: boolean }) {
  const source = props.model.choreDetails.find((row) => row.choreId === props.choreId);
  if (!source) return <V2FormScrollView><View style={{ padding: 16, gap: 14 }}>{props.header}<BackButton onPress={props.onBack} />
    <Text style={styles.body}>この家事の編集情報を取得できませんでした。</Text><AppButton title="編集情報を再読込" variant="secondary" onPress={() => void props.onSaved().catch(() => undefined)} /></View></V2FormScrollView>;
  return <Details key={`${props.model.viewerUserId}:${props.model.plan.groupId}:${props.choreId}`} {...props} source={source} />;
}

function Details({ model, choreId, controller, source, onSaved, onBack, onConfiguration, onDateRights, header, embedded }: Parameters<typeof V2ChoreDetailsEditor>[0] & {
  source: V2GroupScreenModel['choreDetails'][number];
}) {
  const autosave = useV2FieldAutosave({ fields: source.fields, codecs: v2ChoreDetailCodecs,
    save: (edits) => controller.actions.patchChoreDetails(choreId, edits), onSaved }, `details:${choreId}`);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
  const field = (key: V2ChoreDetailField, label: string, multiline = false) => {
    const current = conflict(key); return <View style={styles.group}>{current ? choose(key, current) : <V2TextField label={label} value={textValue(key)} multiline={multiline}
      maxLength={key === 'name' ? 500 : undefined} editable={!disabled} onChangeText={(value) => autosave.change(key, value)} onEndEditing={() => void autosave.flush()} />}{fieldError(key)}</View>;
  };
  const sections = Array.isArray(autosave.raw.procedureSections) ? autosave.raw.procedureSections as unknown as V2SectionDraft[] : [];
  const updateSection = (index: number, patch: Partial<V2SectionDraft>) => autosave.changeWith('procedureSections', (value) => (value as unknown as V2SectionDraft[])
    .map((section, position) => position === index ? { ...section, ...patch } : section) as unknown as JsonValue);
  const panel = (key: string, title: string, children: ReactNode) => <AccordionSection title={title} expanded={expanded[key] === true}
    onToggle={() => setExpanded((value) => ({ ...value, [key]: !value[key] }))}>{children}</AccordionSection>;
  const Container = embedded ? View : V2FormScrollView;
  return <Container {...(embedded ? { style: { gap: 14 } } : { contentContainerStyle: { padding: 16, gap: 16, paddingBottom: 40 }, header: <BackButton disabled={autosave.leaving} onPress={() => void autosave.navigateAfterSave(onBack)} /> })}>{header}
    {!embedded ? <>
    <ScreenHeading title="家事名・手順の編集" /><Text style={styles.caption}>この内容はグループ全員に公開されます。</Text></> : null}
    {blocked ? <Text accessibilityRole="alert" style={styles.error}>家事の削除・復元の確認が必要です。入力は保持しています。</Text> : null}
    <Card>{field('name', '共有家事の名前')}</Card>
    {panel('description', '説明', field('description', '共有家事の説明', true))}
    {panel('procedures', '家事の手順', <View style={styles.group}>
      <SectionHeading title="区分ごとの手順" level="subsection" />
      {conflict('procedureSections') ? choose('procedureSections', autosave.fields.procedureSections) : <>
        {sections.map((section, index) => <Card key={index}>
          <V2TextField label={`手順の区分${index + 1}の見出し`} value={section.title} editable={!disabled}
            onChangeText={(title) => updateSection(index, { title })} onEndEditing={() => void autosave.flush()} />
          <V2TextField label={`手順の区分${index + 1}（1行に1手順）`} value={section.text} multiline editable={!disabled}
            onChangeText={(text) => updateSection(index, { text })} onEndEditing={() => void autosave.flush()} />
          <AppButton title={`区分${index + 1}を削除`} compact variant="quiet" disabled={disabled} onPress={() => autosave.changeWith('procedureSections',
            (value) => (value as unknown as V2SectionDraft[]).filter((_, position) => position !== index) as unknown as JsonValue)} />
        </Card>)}
        <AppButton title="手順の区分を追加" compact variant="secondary" disabled={disabled} onPress={() => autosave.changeWith('procedureSections',
          (value) => [...value as JsonValue[], { title: '', text: '' }])} />
      </>}
      {fieldError('procedureSections')}
      <Text style={styles.caption}>区分があるときは、区分ごとの手順を表示します。</Text>
      {field('instructions', '区分がないときの手順（1行に1手順）', true)}
    </View>)}
    {panel('tools', '使う道具', field('tools', '道具（1行に1項目）', true))}
    {panel('cautions', '注意点', field('cautions', '注意点（1行に1項目）', true))}
    <V2AutosaveFeedback status={autosave.status} refreshError={autosave.refreshError} hasDraft={autosave.hasDraft()} flush={autosave.flush}
      discard={autosave.discard} discardTitle="入力を最新の内容に戻す" disabled={autosave.leaving} />
    {onConfiguration && model.viewerUserId === model.adminUserId ? <AppButton title="周期・担当の設定へ" variant="secondary" disabled={disabled}
      onPress={() => void autosave.navigateAfterSave(onConfiguration)} /> : null}
    {onDateRights && model.viewerUserId === model.adminUserId ? <AppButton title="日時変更の権限へ" variant="secondary" disabled={disabled}
      onPress={() => void autosave.navigateAfterSave(onDateRights)} /> : null}
  </Container>;
}
