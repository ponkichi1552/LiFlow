import { useState } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { AppButton, BackButton, Card, ScreenHeading } from '../../../components/planner-ui';
import { AccordionSection } from '../../../components/accordion-section';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { JsonValue } from '../operations';
import type { GroupPolicy } from '../v2/model';
import { useV2FieldAutosave } from './use-field-autosave';
import { V2Choices, V2Flag, V2FormScrollView, v2FormStyles as styles } from './form-controls';
import { V2AutosaveFeedback } from './autosave-feedback';
import { v2MemberLabels } from './member-labels';
import type { V2FieldCodec } from './field-editor-state';
import { V2GroupSettingsFields, groupNameCodec, groupRegionCodec } from './group-settings-fields';

const policyCodec: V2FieldCodec = { format: value => value ?? null, parse: raw => raw };
const sections = [
  { key: 'dates', title: '日時変更のルール', fields: [
    ['allowBeforeWindow', '担当者の期間前への変更を許可'], ['allowAfterWindow', '担当者の期間後への変更を許可'],
    ['adminCanFixWithoutConsent', '管理者の指定を本人承認なしで確定'], ['autoApproveEarlier', '前倒しの変更を自動承認'],
  ] },
  { key: 'assignment', title: '担当と完了状況', fields: [
    ['delegationEnabled', '家事ごとの権限委譲を有効にする'], ['allowSubstitution', '他のメンバーによる代行を許可'], ['showCompletionStatus', 'アプリ内に完了状況を表示'],
    ['completionPushEnabled', 'メンバーの完了を通知'],
  ] },
] as const;

export function V2GroupPolicyEditor(props: { model: V2GroupScreenModel; controller: V2GroupController; onSaved: () => Promise<void>; onBack: () => void; header?: ReactNode }) {
  if (!props.model.groupPolicy || props.model.groupPolicy.kind === 'missing') return <V2FormScrollView contentContainerStyle={{ padding: 16, gap: 14 }} header={<BackButton onPress={props.onBack} />}>
    {props.header}<Text style={styles.body}>グループのルールを取得できませんでした。</Text>
    <AppButton title="グループのルールを再読込" variant="secondary" onPress={() => void props.onSaved().catch(() => undefined)} />
  </V2FormScrollView>;
  return <Editor key={`${props.model.viewerUserId}:${props.model.plan.groupId}:${props.model.adminUserId}`} {...props} source={props.model.groupPolicy} />;
}
function Editor({ model, source, controller, onSaved, onBack, header }: Parameters<typeof V2GroupPolicyEditor>[0] & { source: NonNullable<V2GroupScreenModel['groupPolicy']> }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const admin = model.viewerUserId === model.adminUserId; const nameOf = v2MemberLabels(model.plan.members);
  const autosave = useV2FieldAutosave({ fields: { ...model.groupSettings, configuration: source },
    codecs: { name: groupNameCodec, timeZone: groupRegionCodec, configuration: policyCodec },
    save: edits => controller.actions.editGroupOptions(edits), onSaved });
  const policy = autosave.fields.configuration.kind === 'conflict' ? null : autosave.raw.configuration as unknown as GroupPolicy;
  const patch = (value: Partial<GroupPolicy>) => autosave.changeWith('configuration', raw => ({ ...raw as object, ...value }) as JsonValue);
  const details = (value: GroupPolicy, editable: boolean) => <View style={styles.group}>
    {editable ? <V2Choices label="グループの種類" value={value.kind} choices={[{ value: 'family', label: '家族' }, { value: 'roommates', label: '同居人' }]}
      disabled={autosave.leaving} onChange={kind => patch({ kind })} /> : <Text style={styles.body}>グループの種類：{value.kind === 'family' ? '家族' : '同居人'}</Text>}
    {sections.map(section => <AccordionSection key={section.key} title={section.title} expanded={expanded[section.key] === true}
      onToggle={() => setExpanded(current => ({ ...current, [section.key]: !current[section.key] }))}>
      {section.fields.map(([key, label]) => editable ? <V2Flag key={key} label={label} value={value[key]} disabled={autosave.leaving} onChange={checked => patch({ [key]: checked })} />
        : <Text key={key} style={styles.caption}>{label}：{value[key] ? 'ON' : 'OFF'}</Text>)}
      {section.key === 'assignment' ? <Text style={styles.caption}>委譲機能をONにしても、個別の権限は付与されません。家事ごとに管理者が設定します。</Text> : null}
      {section.key === 'assignment' ? <Text style={styles.caption}>完了状況の表示がOFFでも、自分の担当・実施・登録分と管理者の確認用の情報は表示します。</Text> : null}
      {section.key === 'assignment' ? <Text style={styles.caption}>完了通知は初期OFFです。ONにすると、同期で受信した完了を通知が許可された端末に表示します。過去分はまとめて通知せず、同じ家事回は1回だけ通知します。即時の受信や配信は保証されず、端末の通知上限で省略される場合もあります。完了履歴は残ります。</Text> : null}
    </AccordionSection>)}
  </View>;
  return <V2FormScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }} header={<BackButton disabled={autosave.leaving} onPress={() => void autosave.navigateAfterSave(onBack)} />}>{header}
    <ScreenHeading title="グループ名・ルール" />
    <Text style={styles.caption}>{admin ? '変更は全メンバーに適用されます。種類を変えても現在の個別設定は保持します。' : 'ルールは管理者が変更します。'}</Text>
    {model.groupSettings ? <View>
      <V2GroupSettingsFields autosave={autosave} model={model} admin={admin} />
    </View> : null}
    {policy ? details(policy, admin) : <Card><Text style={styles.error}>ルールが競合しています。候補を開いて内容を確認してください。</Text>
      {autosave.fields.configuration.candidates.map((candidate, index) => <AccordionSection key={candidate.operationId} title={`ルール候補${index + 1} · ${nameOf(candidate.authorUserId)}`}
        expanded={expanded[candidate.operationId] === true} onToggle={() => setExpanded(current => ({ ...current, [candidate.operationId]: !current[candidate.operationId] }))}>
        {details(candidate.value as unknown as GroupPolicy, false)}
        {admin ? <AppButton title={`ルール候補${index + 1}で解決する`} variant="secondary" disabled={autosave.leaving}
          onPress={() => autosave.resolve('configuration', candidate.value)} /> : null}
      </AccordionSection>)}
    </Card>}
    {admin ? <V2AutosaveFeedback status={autosave.status} refreshError={autosave.refreshError} hasDraft={autosave.hasDraft()} flush={autosave.flush}
      discard={autosave.discard} discardTitle="入力を最新のルールに戻す" disabled={autosave.leaving} /> : null}
  </V2FormScrollView>;
}
