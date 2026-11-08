import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, Card, SectionHeading, typography } from '../../../components/planner-ui';
import { V2Choices, v2FormStyles } from '../v2-ui/form-controls';
import type { GroupKind } from './model';
import type { LegacyMigrationReview } from './live-legacy-migration';
import type { LegacyMigrationWorkspace } from '../../../platform/sharing/workspace-types';

/** This screen can drain existing edits or migrate; it exposes no legacy planner/editor. */
export function LegacyMigrationPanel({ workspace, run, busy }: {
  workspace: LegacyMigrationWorkspace; run: (work: () => Promise<void>) => Promise<boolean>; busy: boolean;
}) {
  const [kind, setKind] = useState<GroupKind | ''>('');
  const [review, setReview] = useState<LegacyMigrationReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isOwner = workspace.roster()?.body.ownerDeviceId === workspace.identity.deviceId;
  useEffect(() => {
    let current = true;
    if (isOwner) void workspace.migration.resumeReview().then(value => {
      if (current && value) { setReview(value); setKind(value.kind); }
    }).catch(() => { if (current) setError('保存済みの移行確認を読み込めませんでした。元のデータは保持しています。'); });
    return () => { current = false; };
  }, [workspace, isOwner]);
  return <Card>
    <SectionHeading title="共有グループをv2へ移行" />
    <Text style={typography.body}>これまでの家事・設定・完了と取り消しの履歴を引き継ぎます。個人データは変更しません。</Text>
    <Text style={typography.caption}>参加端末を最新のLiFlowに更新し、各端末の未送信変更を同期してください。移行前のデータも端末に保持します。</Text>
    <AppButton title="移行前の変更を同期" variant="secondary" disabled={busy} onPress={() => void run(async () => { await workspace.sync({ force: true, budgetMs: 120_000 }); })} />
    {isOwner ? <>
      <V2Choices label="移行後のグループの種類" value={kind} choices={[{ value: 'family', label: '家族' }, { value: 'roommates', label: '同居人' }]}
        disabled={busy} onChange={value => { if (value === 'family' || value === 'roommates') { setKind(value); setReview(null); } }} />
      <AppButton title="引き継ぐ内容を確認" disabled={busy || !kind} variant="secondary" onPress={() => void run(async () => {
        if (!kind) return;
        const value = await workspace.migration.prepare(kind); setReview(value); setError(null);
      })} />
      {review ? <View style={{ gap: 10 }}>
        <Text style={typography.subheading}>引き継ぐ内容</Text>
        <Text style={typography.caption}>メンバー{review.memberCount}人・元の署名付き記録{review.historyCount}件。家事の名前・手順・負荷・休日・ゴミ収集日・家電・履歴を保持します。</Text>
        {review.chores.map(chore => <Text key={chore.id} style={typography.body}>{chore.name}{'\n'}
          {chore.enabled ? `${chore.intervalDays}日ごと・${chore.assignees ? `現在の担当${chore.assignees}人` : '共通の家事'}` : '無効を維持'}</Text>)}
        <Text style={typography.caption}>有効な家事は、確認した周期・実施期間と現在の担当を引き継ぎます。過去の実施者や履歴を新しい完了記録に書き換えません。</Text>
        <AppButton title="この内容でv2へ移行" disabled={busy} onPress={() => void run(async () => { await workspace.migration.commit(review.id); })} />
      </View> : null}
    </> : <Text style={typography.body}>管理者の端末で移行内容を確認すると、この端末にもv2の履歴と設定が届きます。</Text>}
    {error ? <Text accessibilityRole="alert" style={v2FormStyles.error}>{error}</Text> : null}
  </Card>;
}
