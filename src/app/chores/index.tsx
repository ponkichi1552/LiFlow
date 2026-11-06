import { SettingsSwitch as Switch } from '@/components/settings-switch';
import { FormTextInput as TextInput } from '../../components/form-text-input';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppButton, BackButton, Card, ChoiceChip, Page, ScreenHeading, SectionHeading, StatusBadge, palette, typography } from '@/components/planner-ui';
import type { ChoreDefinition } from '@/domain/chores/types';
import { choreCadenceLabel } from '@/domain/chores/cycle-policy';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePlannerData } from '@/hooks/use-planner-data';
import { setChoreEnabled } from '@/platform/storage/repository';

export default function ChoresScreen() {
  const { snapshot, loading, error, refresh, database } = usePlannerData();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('すべて');
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const chores = useMemo(() => snapshot?.chores.filter((chore) => !chore.archived) ?? [], [snapshot?.chores]);
  const categories = useMemo(() => ['すべて', ...new Set(chores.map((chore) => chore.category))], [chores]);
  const visibleChores = useMemo(() => {
    if (!snapshot) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return chores.filter((chore) =>
      (category === 'すべて' || chore.category === category)
      && (!normalizedQuery || `${chore.name} ${chore.category} ${chore.locationOrAppliance ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [snapshot, chores, query, category]);

  if (loading || !snapshot) return <PlannerLoadState title="家事一覧" message="家事を読み込んでいます。" error={error} retry={refresh} />;

  const statusByChore = new Map<string, string>();
  for (const entry of snapshot.scheduleEntries) {
    const previous = statusByChore.get(entry.choreId);
    if (!previous || statusRank(entry.status) < statusRank(previous)) statusByChore.set(entry.choreId, entry.status);
  }

  const toggle = async (chore: ChoreDefinition, enabled: boolean) => {
    setWorkingId(chore.id);
    setToggleError(null);
    try {
      await setChoreEnabled(database, chore.id, enabled);
      await refresh();
    } catch (cause) {
      setToggleError(cause instanceof Error ? cause.message : '家事の設定を変更できませんでした。');
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <Page header={<BackButton onPress={() => router.back()} />}>

      <ScreenHeading eyebrow="CHORES" title="家事一覧" description={`${chores.filter((chore) => chore.enabled).length}件の家事を有効にしています。検索や設定変更ができます。`} />
      {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}
      {toggleError ? <Card><Text style={styles.error}>{toggleError}</Text></Card> : null}
      <Card style={styles.applianceCard}>
        <Text style={styles.applianceTitle}>家電のお手入れを追加</Text>
        <Text style={styles.emptyText}>メーカー公式の取扱説明書を確認し、お手入れ項目を選んで家事に登録できます。</Text>
        <AppButton title="家電一覧を開く" onPress={() => router.push('/manual')} compact />
      </Card>
      {snapshot.appliances.length > 0 ? (
        <>
          <SectionHeading title="登録した家電" trailing={<Text style={styles.meta}>{snapshot.appliances.length}台</Text>} />
          {snapshot.appliances.map((appliance) => (
            <Card key={appliance.id} style={styles.savedApplianceCard}>
              <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/manual/appliances/[id]', params: { id: appliance.id, returnTo: '/chores' } }, { withAnchor: true })} style={styles.choreCopy}>
                <Text style={styles.choreName}>{appliance.displayName}</Text>
                <Text style={styles.meta}>{appliance.analysis.tasks.length}件のお手入れ項目 · 詳細と出典</Text>
              </Pressable>
              <AppButton title="再解析" onPress={() => router.push({ pathname: '/manual/appliance-care', params: { applianceId: appliance.id, returnTo: '/chores' } }, { withAnchor: true })} variant="secondary" compact />
            </Card>
          ))}
        </>
      ) : null}
      <TextInput
        accessibilityLabel="家事を検索"
        value={query}
        onChangeText={setQuery}
        placeholder="家事名・場所で検索"
        placeholderTextColor={palette.muted}
        style={styles.search}
        returnKeyType="search"
      />
      <View style={styles.categories}>
        {categories.map((item) => <ChoiceChip key={item} label={item} selected={category === item} onPress={() => setCategory(item)} />)}
      </View>
      {visibleChores.length === 0 ? (
        <Card><Text style={styles.emptyTitle}>家事が見つかりません</Text><Text style={styles.emptyText}>検索語やカテゴリを変えてください。</Text></Card>
      ) : visibleChores.map((chore) => (
        <Card key={chore.id} style={styles.choreCard}>
          <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/settings/chore/[id]', params: { id: chore.id } })} style={styles.choreCopy}>
            <View style={styles.titleRow}>
              <Text style={styles.choreName}>{chore.name}</Text>
              {chore.enabled ? <StatusBadge status={statusByChore.get(chore.id) ?? 'initialPending'} /> : <Text style={styles.offTag}>OFF</Text>}
            </View>
            <Text style={styles.meta}>{chore.category} · {choreCadenceLabel(chore, snapshot.settings.frequencyMode)}{chore.estimatedMinutes ? ` · 約${chore.estimatedMinutes}分` : ''}</Text>
            {chore.enabled ? <Text style={styles.period}>{scheduleLabel(snapshot.scheduleEntries.find((entry) => entry.choreId === chore.id))}</Text> : null}
          </Pressable>
          <View style={styles.footer}>
            <AppButton title="個別設定" onPress={() => router.push({ pathname: '/settings/chore/[id]', params: { id: chore.id } })} variant="secondary" compact />
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>{chore.enabled ? '有効' : '無効'}</Text>
              <Switch
                value={chore.enabled}
                disabled={workingId === chore.id || (!chore.enabled && Boolean(chore.requiresCycleSelection))}
                onValueChange={(value) => void toggle(chore, value)}
              />
            </View>
          </View>
        </Card>
      ))}
      <Text style={styles.footnote}>家事を無効にしても、過去の完了履歴は残ります。</Text>
    </Page>
  );
}

function scheduleLabel(entry: { windowStart: string; windowEnd: string; status: string } | undefined): string {
  if (!entry) return '予定を計算中';
  if (entry.status === 'overdue') return '推奨期間を超過';
  return `${entry.windowStart.replaceAll('-', '/')}〜${entry.windowEnd.replaceAll('-', '/')}`;
}

function statusRank(status: string): number {
  return status === 'overdue' ? 0 : status === 'inWindow' ? 1 : status === 'initialPending' ? 2 : 3;
}

const styles = StyleSheet.create({
  search: { ...typography.body, minHeight: 54, borderRadius: 14, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 15, color: palette.ink },
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  choreCard: { gap: 12 },
  applianceCard: { backgroundColor: palette.accentSoft, borderColor: palette.border },
  savedApplianceCard: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  applianceTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  choreCopy: { gap: 5 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  choreName: { ...typography.subheading, flex: 1, color: palette.ink, fontWeight: '700' },
  meta: { ...typography.caption, color: palette.muted },
  period: { ...typography.caption, color: palette.accent, fontWeight: '600' },
  offTag: { ...typography.caption, color: palette.muted, backgroundColor: palette.background, borderRadius: 8, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 4, fontWeight: '700' },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border, paddingTop: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  switchLabel: { ...typography.caption, color: palette.muted, fontWeight: '600' },
  emptyTitle: { ...typography.body, color: palette.ink, fontWeight: '700' },
  emptyText: { ...typography.body, color: palette.muted },
  footnote: { ...typography.caption, color: palette.muted, textAlign: 'center' },
  error: { ...typography.label, color: palette.warning },
});
