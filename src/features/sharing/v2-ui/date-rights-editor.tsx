import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { AppButton, BackButton, Card, ScreenHeading } from '../../../components/planner-ui';
import { AccordionSection } from '../../../components/accordion-section';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { JsonValue } from '../operations';
import type { V2DateRightsValue } from '../v2/date-rights-edit';
import type { V2FieldCodec } from './field-editor-state';
import { useV2FieldAutosave } from './use-field-autosave';
import { V2AutosaveFeedback } from './autosave-feedback';
import { V2Flag, V2FormScrollView, v2FormStyles as styles } from './form-controls';
import { v2MemberLabels } from './member-labels';

const empty: V2DateRightsValue = { enabled: false, rights: { changeDate: false, changeOthers: false, changeBeforeWindow: false } };
const codec: V2FieldCodec = { format: value => value ?? JSON.parse(JSON.stringify(empty)), parse: raw => raw };
const rights = [['changeDate', '日時を指定できる'], ['changeOthers', '他の担当者の日時も変更できる'], ['changeBeforeWindow', '期間前への変更ができる']] as const;
const label = (value: V2DateRightsValue) => `${value.enabled ? '有効' : '無効'}\n${rights.map(([key, title]) => `${title}：${value.rights[key] ? 'ON' : 'OFF'}`).join('\n')}`;
const keyOf = (userId: string, since: number) => JSON.stringify([userId, since]);
function targetOf(key: string): { userId: string; expectedMembershipStart: number } {
  const value = JSON.parse(key);
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !Number.isSafeInteger(value[1]) || value[1] < 1) throw new Error('メンバーの参加状態を確認してください。');
  return { userId: value[0], expectedMembershipStart: value[1] };
}

export function V2DateRightsEditor(props: { model: V2GroupScreenModel; choreId: string; controller: V2GroupController;
  onSaved: () => Promise<void>; onBack: () => void; onGroupPolicy?: () => void; header?: ReactNode; embedded?: boolean }) {
  const { model, choreId, onBack, header } = props;
  if (model.viewerUserId !== model.adminUserId) return <V2FormScrollView contentContainerStyle={{ padding: 16, gap: 14 }} header={<BackButton onPress={onBack} />}>{header}
    <ScreenHeading title="日時変更の権限" /><Text style={styles.caption}>メンバーへの権限は管理者が設定します。</Text></V2FormScrollView>;
  const source = model.dateRights;
  if (!source || source.choreId !== choreId) return <V2FormScrollView contentContainerStyle={{ padding: 16, gap: 14 }} header={<BackButton onPress={onBack} />}>{header}
    <Text style={styles.body}>この家事の権限を取得できませんでした。</Text><AppButton title="権限を再読込" variant="secondary" onPress={() => void props.onSaved().catch(() => undefined)} /></V2FormScrollView>;
  return <Editor key={`${model.viewerUserId}:${model.plan.groupId}:${choreId}`} {...props} source={source} />;
}

function Editor({ model, source, choreId, controller, onSaved, onBack, onGroupPolicy, header, embedded }: Parameters<typeof V2DateRightsEditor>[0] & { source: NonNullable<V2GroupScreenModel['dateRights']> }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({}); const nameOf = v2MemberLabels(model.plan.members);
  const policy = model.groupPolicy; const delegation = model.plan.policy?.delegationEnabled === true;
  const displayedPolicy = useRef<readonly string[] | null>(null);
  const blocked = source.alive.kind !== 'value' || source.alive.value !== true || policy?.kind !== 'value';
  const fields = Object.fromEntries(Object.entries(source.fields).map(([userId, field]) => [keyOf(userId, source.membershipStarts[userId]), field]));
  const autosave = useV2FieldAutosave({ fields, codecs: Object.fromEntries(Object.keys(fields).map(key => [key, codec])),
    save: async edits => {
      const result = await controller.actions.editDateRights(choreId, edits.map(edit => ({ ...edit, ...targetOf(edit.field) })), displayedPolicy.current ?? []);
      return { operations: result.operations, fields: Object.fromEntries(edits.map(edit => [edit.field, result.fields[targetOf(edit.field).userId]])) };
    }, onSaved }, `rights:${choreId}`);
  const targets = [...Object.keys(fields), ...Object.keys(autosave.fields).filter(key => !Object.hasOwn(fields, key) && autosave.isDirty(key))];
  const bindPolicy = () => { if (!autosave.hasDraft()) displayedPolicy.current = policy?.candidates.map(candidate => candidate.operationId) ?? []; };
  const change = (userId: string, patch: (value: V2DateRightsValue) => V2DateRightsValue) => {
    bindPolicy(); autosave.changeWith(userId, raw => patch(raw as unknown as V2DateRightsValue) as unknown as JsonValue);
  };
  const resolve = (userId: string, value: JsonValue) => { bindPolicy(); autosave.resolve(userId, value); };
  const chore = model.plan.chores.find(value => value.id === choreId);
  const Container = embedded ? View : V2FormScrollView;
  return <Container {...(embedded ? { style: { gap: 14 } } : { contentContainerStyle: { padding: 16, gap: 16, paddingBottom: 40 }, header: <BackButton disabled={autosave.leaving} onPress={() => void autosave.navigateAfterSave(onBack)} /> })}>{header}
    {!embedded ? <><ScreenHeading title="日時変更の権限" />
    <Text style={styles.body}>{chore?.name}</Text></> : null}<Text style={styles.caption}>この家事だけに適用します。日時厳守・固定・本人承認などの条件は引き続き適用されます。</Text>
    {blocked ? <Text accessibilityRole="alert" style={styles.error}>家事またはグループのルールの確認が必要です。入力は保持しています。</Text> : null}
    {!delegation ? <Text style={styles.caption}>グループの委譲機能はOFFです。保存済みの権限は適用されません。個別の権限を解除することはできます。</Text> : null}
    {targets.length === 0 ? <Card><Text style={styles.body}>権限を設定するメンバーはいません。</Text></Card> : null}
    {targets.map(key => {
      const { userId } = targetOf(key); const field = autosave.fields[key]; const active = Object.hasOwn(fields, key); const disabled = blocked || autosave.leaving || !active;
      if (!field) return <Card key={key}><Text style={styles.caption}>{nameOf(userId)}の設定を読み込んでいます。</Text></Card>;
      const value = autosave.raw[key] as unknown as V2DateRightsValue;
      return <AccordionSection key={key} title={`${nameOf(userId)}の権限${active ? '' : '（以前の参加）'}`} expanded={expanded[key] === true}
        onToggle={() => setExpanded(current => ({ ...current, [key]: !current[key] }))}>
        {!active ? <Text style={styles.error}>参加状態が変わったため保存できません。入力は保持しています。</Text> : null}
        {field.kind === 'conflict' ? <View style={styles.group}><Text style={styles.error}>付与と取消の候補を確認してください。候補同士を自動で組み合わせません。</Text>
          {field.candidates.map((candidate, index) => {
            const choice = candidate.value as unknown as V2DateRightsValue;
            return <AccordionSection key={candidate.operationId} title={`${nameOf(userId)}の権限候補${index + 1}`} expanded={expanded[candidate.operationId] === true}
              onToggle={() => setExpanded(current => ({ ...current, [candidate.operationId]: !current[candidate.operationId] }))}>
              <Text style={styles.body}>{label(choice)}</Text>
              <AppButton title={`権限候補${index + 1}で解決する`} accessibilityLabel={`${nameOf(userId)}の権限候補${index + 1}で解決する`} variant="secondary"
                disabled={disabled || !delegation && choice.enabled} onPress={() => resolve(key, candidate.value)} />
            </AccordionSection>;
          })}
          <AppButton title="権限を解除して解決する" accessibilityLabel={`${nameOf(userId)}の権限を解除して解決する`} variant="quiet" disabled={disabled}
            onPress={() => resolve(key, empty as unknown as JsonValue)} />
        </View> : <View style={styles.group}>
          <V2Flag label={`${nameOf(userId)}への権限を有効にする`} value={value.enabled} disabled={disabled || !delegation && !value.enabled}
            onChange={enabled => change(key, current => ({ ...current, enabled }))} />
          {rights.map(([right, title]) => <V2Flag key={right} label={`${nameOf(userId)}：${title}`} value={value.rights[right]}
            disabled={disabled || !delegation || !value.enabled || right !== 'changeDate' && !value.rights.changeDate}
            onChange={checked => change(key, current => ({ ...current, rights: { ...current.rights, [right]: checked } }))} />)}
          <Text style={styles.caption}>「日時を指定できる」がOFFの場合、他の2項目も適用されません。</Text>
        </View>}
        {!active && autosave.isDirty(key) ? <AppButton title="このメンバーの入力を戻す" variant="quiet" onPress={() => autosave.discard(key)} /> : null}
      </AccordionSection>;
    })}
    <V2AutosaveFeedback status={autosave.status} refreshError={autosave.refreshError} hasDraft={autosave.hasDraft()} flush={autosave.flush}
      discard={autosave.discard} discardTitle="入力を最新の権限に戻す" disabled={autosave.leaving} />
    {onGroupPolicy ? <AppButton title="グループのルールへ" variant="secondary" disabled={autosave.leaving}
      onPress={() => void autosave.navigateAfterSave(onGroupPolicy)} /> : null}
  </Container>;
}
