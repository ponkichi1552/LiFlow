import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { AccordionSection } from '../../../components/accordion-section';
import { palette, typography } from '../../../components/planner-ui';
import { SettingsCheckbox } from '../../../components/settings-checkbox';
import { SettingsAction } from '../../../components/settings-controls';
import type { V2WorkspaceSession } from './workspace-session';

type Recovery = V2WorkspaceSession['recovery'];
type Saved = Awaited<ReturnType<Recovery['readSummary']>>;
export function V2RecoveryPanel({ groupId, recovery, isOwner, devices, busy, run, initiallyExpanded = false, embedded = false }: {
  groupId: string; recovery: Recovery; isOwner: boolean; devices: { deviceId: string; displayName: string }[];
  busy: boolean; run: (work: () => Promise<void>) => Promise<boolean>; initiallyExpanded?: boolean; embedded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded); const [saved, setSaved] = useState<Saved>(null);
  const [acknowledged, setAcknowledged] = useState(false); const [loading, setLoading] = useState(initiallyExpanded || embedded);
  const [error, setError] = useState<string | null>(null); const mounted = useRef(false);
  const [showEvidence, setShowEvidence] = useState(false); const [page, setPage] = useState(0);
  const refresh = useCallback(async () => {
    const value = await recovery.readSummary();
    if (value && value.draft.review.groupId !== groupId) throw new Error('復旧確認のグループが一致しません。');
    if (mounted.current) { setSaved(value); setAcknowledged(false); setPage(0); }
  }, [recovery, groupId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!(expanded || embedded) || !recovery.enabled || !isOwner) return;
    let current = true;
    void refresh().catch(() => { if (current) setError('保存済みの復旧確認を読み込めません。変更と証拠は保持しています。'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [expanded, embedded, recovery.enabled, isOwner, refresh]);
  if (!recovery.enabled || !isOwner) return null;
  const action = (work: () => Promise<void>) => {
    if (!mounted.current || busy) return;
    setError(null);
    void run(async () => {
      try { await work(); }
      finally { await refresh(); }
    });
  };
  const review = saved?.draft.review;
  const confirm = () => {
    if (!review || review.groupId !== groupId || busy || !acknowledged) return;
    const { id, reviewDigest } = review;
    const participation = review.removeDeviceIds.length ? '表示した端末の参加を解除し、共有鍵を更新します。' : '参加端末は解除せず、共有鍵を更新します。';
    Alert.alert('確認した内容で復旧しますか？', `読めない変更は予定に反映しません。元の暗号文と確認待ちの内容を保存します。${participation}`, [
      { text: 'キャンセル', style: 'cancel' }, { text: '復旧する', style: 'destructive', onPress: () => action(async () => { await recovery.confirm(id, reviewDigest); }) },
    ]);
  };
  const content = <View style={{ gap: 12 }}>
    <Text style={styles.body}>共有の同期が止まったときに使います。最初に影響だけを確認します。</Text>
    <Text style={styles.caption}>個人データ・未送信の変更・元の暗号文は保持します。</Text>
    {loading ? <ActivityIndicator color={palette.accent} /> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {saved && review ? <View style={styles.review}>
      <Text style={styles.title}>{saved.status === 'applied' ? saved.locallyApplied ? '復旧済み' : '共有先で復旧済み・この端末へ反映待ち' : saved.status === 'cancelled' ? '復旧を中断済み' : saved.status === 'confirming' ? '確認済み・復旧の完了待ち' : '復旧前の影響確認'}</Text>
      <Text style={styles.body}>反映する変更（復元を含む）：{review.retainedChanges}件</Text>
      <Text style={styles.body}>元の署名から復元する変更：{review.restoredOriginals}件</Text>
      <Text style={styles.body}>読めないため隔離する変更：{review.unreadableChanges}件</Text>
      <Text style={styles.body}>関連する確認待ちの変更：{review.heldChanges}件</Text>
      {review.heldChanges ? <Text style={styles.caption}>確認待ちの変更は署名付きの元の内容と受付記録を残します。復旧後も予定へ自動反映しません。</Text> : null}
      <Text style={styles.title}>参加を解除する端末：{review.removeDeviceIds.length}台</Text>
      {review.removeDeviceIds.map(id => <Text key={id} style={styles.body}>{devices.find(device => device.deviceId === id)?.displayName ?? 'メンバー'} · 端末 {id.slice(-8)}</Text>)}
      {review.removeDeviceIds.length ? <Text style={styles.caption}>解除した端末の取得済みデータは消去できません。再参加には新しい招待と承認が必要です。</Text> : null}
      <AccordionSection title="変更と保存する証拠" expanded={showEvidence} onToggle={() => setShowEvidence(value => !value)}>
        {review.entries.slice(page * 20, (page + 1) * 20).map(entry => {
          const original = saved.draft.preservedFacts.find(value => value.fact.operation.operationId === entry.operationId);
          return <View key={entry.operationId} style={styles.evidence}>
            <Text style={styles.title}>{entry.classification === 'restoredOriginal' ? '署名から復元' : entry.classification === 'blockedCausality' ? '確認待ち' : '内容を復号できない変更'}</Text>
            <Text style={styles.caption}>{devices.find(device => device.deviceId === entry.authorDeviceId)?.displayName ?? 'メンバー'} · 端末 {entry.authorDeviceId.slice(-8)}</Text>
            {original ? <Text selectable style={styles.body}>{JSON.stringify(original.fact.operation.payload).slice(0, 1000)}</Text> : null}
            <Text selectable style={styles.caption}>変更番号：{entry.operationId}</Text>
            <Text selectable style={styles.caption}>元の暗号文の照合番号：{entry.rawDigest}</Text>
          </View>;
        })}
        {page > 0 ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="前の20件" compact disabled={busy} onPress={() => setPage(value => value - 1)} /> : null}
        {(page + 1) * 20 < review.entries.length ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="次の20件" compact disabled={busy} onPress={() => setPage(value => value + 1)} /> : null}
      </AccordionSection>
      {saved.status === 'review' || saved.status === 'confirming' ? <>
        <View style={styles.check}><Text style={[styles.body, styles.checkLabel]}>内容と影響を確認しました</Text>
          <SettingsCheckbox value={acknowledged} disabled={busy} onValueChange={setAcknowledged} accessibilityLabel="復旧の内容と参加解除の影響を確認しました" /></View>
        <SettingsAction placement={embedded ? 'panel' : 'page'} title={saved.status === 'confirming' ? '確認した復旧を再開' : 'この内容で復旧'} intent="primary" disabled={busy || !acknowledged} onPress={confirm} />
        <SettingsAction placement={embedded ? 'panel' : 'page'} title="復旧を中断する" intent="destructive" disabled={busy} onPress={() => action(async () => { await recovery.cancel(review.id, review.reviewDigest); })} />
      </> : null}
      {saved.status === 'applied' && !saved.locallyApplied ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="復旧結果をこの端末へ反映" disabled={busy}
        onPress={() => action(async () => { await recovery.confirm(review.id, review.reviewDigest); })} /> : null}
    </View> : null}
    {!saved || ['review', 'cancelled', 'applied'].includes(saved.status) ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="復旧の影響を検査" disabled={busy || loading}
      onPress={() => action(async () => { await recovery.prepare(); })} /> : null}
  </View>;
  return embedded ? content : <AccordionSection title="同期の復旧" expanded={expanded} onToggle={() => { if (!expanded) setLoading(true); setExpanded(!expanded); }}>{content}</AccordionSection>;
}
const styles = StyleSheet.create({
  body: { ...typography.body, color: palette.ink }, caption: { ...typography.caption, color: palette.muted },
  title: { ...typography.subheading, color: palette.ink, fontWeight: '600' }, error: { ...typography.body, color: palette.warning },
  review: { gap: 10, paddingVertical: 8 }, check: { flexDirection: 'row', alignItems: 'center', gap: 12 }, checkLabel: { flex: 1 },
  evidence: { gap: 5, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
});
