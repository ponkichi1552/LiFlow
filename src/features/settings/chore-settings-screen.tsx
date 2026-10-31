import { router, usePreventRemove } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SettingsSwitch as Switch } from '@/components/settings-switch';
import { ChoreBook } from '@/components/chore-book';
import { createChoreSettingsDocument } from '@/features/settings/chore-settings-editor';
import type { ChoreSettingsEditor } from '@/features/settings/chore-settings-editor';
import { NumberInputField } from '@/components/number-input-field';
import { SettingsAudience } from '@/components/settings-audience';

import { AppButton, BackButton, Card, ChoiceChip, Page, ScreenHeading, SectionHeading, palette, typography } from '@/components/planner-ui';
import type { ChoreDefinition, ChoreLoad } from '@/domain/chores/types';
import { formatJapaneseDate, localDateFromISODateTime } from '@/domain/scheduling/local-date';
import { PlannerLoadState } from '@/components/planner-load-state';
import type { usePlannerData } from '@/hooks/use-planner-data';
import { updateChoreSettings } from '@/platform/storage/repository';
import type { PlannerSnapshot } from '@/platform/storage/repository';

import { useChoreSettingsAutosave } from '@/features/settings/use-chore-settings-autosave';
import type { ChoreSettingsPatch } from '@/domain/chores/settings-patch';
import { parseSettingInteger } from '@/domain/chores/settings-patch';

const loadOptions: { id: ChoreLoad; label: string }[] = [
  { id: 'light', label: '軽い' }, { id: 'normal', label: '普通' }, { id: 'heavy', label: '重い' },
];

export function ChoreSettingsBook({ choreId, data }: { choreId: string; data: Pick<ReturnType<typeof usePlannerData>, 'snapshot' | 'loading' | 'error' | 'refresh' | 'database'> }) {
  const { snapshot, loading, error, refresh, database } = data;
  const [reloadVersion, setReloadVersion] = useState(0);
  const caches = useMemo(() => createChoreSettingsDocument(database), [database]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const leaving = useRef(false);
  const chore = snapshot?.chores.find((item) => item.id === choreId);
  const leaveAfterSave = async (navigate: () => void) => {
    if (leaving.current) return; leaving.current = true;
    try {
      for (const [id, cache] of caches.entries()) {
        const saved = await cache.flush(); const draft = cache.getSnapshot().draft;
        const invalid = Boolean(draft.cycleText.trim() && parseSettingInteger(draft.cycleText, 1, 3650) === undefined)
          || parseSettingInteger(draft.radiusText, 0, 14) === undefined;
        if (!saved || invalid) {
          setSaveError(invalid ? '数値に入力の誤りがあります。表示中の家事で確認してください。' : '保存できていない変更があります。該当する家事で再試行してください。');
          router.setParams({ id }); return;
        }
      }
      disablePrevention(); navigate();
    } finally { leaving.current = false; }
  };
  const disablePrevention = usePreventRemove(true, ({ repeat }) => { void leaveAfterSave(repeat); });
  if (loading || !snapshot) return <PlannerLoadState title="家事ごとの設定" message="設定を読み込んでいます。" error={error} retry={refresh} />;
  if (!chore) return <Page header={<BackButton onPress={() => void leaveAfterSave(() => router.back())} />}><ScreenHeading title="家事が見つかりません" /></Page>;
  const rows = snapshot.chores.filter(item => !item.archived);
  const back = () => leaveAfterSave(() => router.back());
  return <ChoreBook chores={rows} selectedId={choreId} title="家事ごとの設定" onBack={() => void back()}
    titleAccessory={<SettingsAudience groupName={snapshot.sharing ? snapshot.household.name : undefined} />}
    header={saveError || error ? <Text accessibilityRole="alert" style={styles.error}>{saveError ?? error}</Text> : undefined}
    renderChore={item => {
      const cache = caches.get(item, snapshot.settings.frequencyMode, async (patch, base) => { if (await updateChoreSettings(database, item.id, patch, base)) await refresh(); });
      return <ChoreSettingsContent key={`${item.id}:${reloadVersion}`} chore={item} snapshot={snapshot} error={null} cache={cache}
        onReload={async () => { await refresh(); caches.forget(item.id); setReloadVersion(version => version + 1); }}
        savePatch={async (patch, base) => { if (await updateChoreSettings(database, item.id, patch, base)) await refresh(); }} />;
    }} />;
}

function ChoreSettingsContent({
  chore,
  snapshot,
  error,
  savePatch,
  onReload,
  cache,
}: {
  chore: ChoreDefinition;
  cache?: ChoreSettingsEditor;
  snapshot: PlannerSnapshot;
  error: string | null;
  savePatch: (patch: ChoreSettingsPatch, displayedBase: ChoreDefinition) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const autosave = useChoreSettingsAutosave(chore, snapshot.settings.frequencyMode, savePatch, cache);
  const { cycleText, radiusText, load, holidayPriority, dryingPreference, enabled } = autosave.draft;

  const state = snapshot.states.find((item) => item.choreId === chore.id);
  const previousCompletion = snapshot.completions
    .filter((item) => item.choreId === chore.id && item.outcome === 'completed')
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
  const latestCompletion = state?.lastCompletedDate ?? (previousCompletion ? localDateFromISODateTime(previousCompletion.completedAt) : undefined);

  return (
    <View style={{ gap: 12 }}>
      <ScreenHeading title={`${chore.name}の設定`} />
      {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}

      <Card>
        <SectionHeading title="基本" level="subsection" />
        <View style={styles.settingRow}>
          <View style={styles.settingCopy}>
            <Text style={styles.settingTitle}>家事を有効にする</Text>
            <Text style={styles.body}>{chore.requiresCycleSelection ? '周期を設定してから有効にできます。' : '無効にしても完了履歴は残ります。'}</Text>
          </View>
          <Switch value={enabled} accessibilityLabel="家事を有効にする" onValueChange={autosave.changeEnabled} disabled={chore.requiresCycleSelection && parseSettingInteger(cycleText, 1, 3650) === undefined} />
        </View>
        <View style={styles.fieldRow}>
          <View style={styles.settingCopy}>
            <Text style={styles.settingTitle}>周期</Text>
            <Text style={styles.body}>
              {chore.applianceCareSource && chore.manufacturerRecommendedIntervalDays === undefined
                ? 'メーカー指定なし。周期を入力するまでは予定に追加されません。'
                : chore.manufacturerRecommendedIntervalDays !== undefined
                  ? `メーカー推奨：${chore.manufacturerRecommendedIntervalDays}日${(chore.userIntervalDays ?? chore.recommendedCycleDays) !== undefined && (chore.userIntervalDays ?? chore.recommendedCycleDays) !== chore.manufacturerRecommendedIntervalDays ? ` · あなたの設定：${chore.userIntervalDays ?? chore.recommendedCycleDays}日` : ''}`
                  : `頻度モードの初期値は${chore.frequencyDaysByMode[snapshot.settings.frequencyMode]}日です。`}
            </Text>
          </View>
          <NumberInputField
            value={cycleText}
            onChangeText={autosave.changeCycle}
            onEndEditing={() => void autosave.flush()}
            accessibilityLabel="家事周期の日数"
            placeholder={chore.requiresCycleSelection ? '入力' : undefined}
          />
        </View>
        {autosave.cycleError ? <Text style={styles.error}>{autosave.cycleError}</Text> : null}
        {chore.schedulingNotes ? <Text style={styles.body}>{chore.schedulingNotes}</Text> : null}
        {chore.applianceId && chore.manufacturerRecommendedIntervalDays !== undefined
          && (chore.userIntervalDays ?? chore.recommendedCycleDays) !== undefined
          && (chore.userIntervalDays ?? chore.recommendedCycleDays) !== chore.manufacturerRecommendedIntervalDays ? (
            <AppButton title="メーカー推奨に戻す" onPress={autosave.resetCycle} variant="quiet" compact />
          ) : null}

        <SectionHeading title="実施スケジュール" level="subsection" />
        <View style={styles.fieldRow}>
          <View style={styles.settingCopy}><Text style={styles.settingTitle}>実施期間の幅</Text><Text style={styles.body}>基準日から前後に何日広げるか（0〜14日）</Text></View>
          <NumberInputField prefix="±" value={radiusText} onChangeText={autosave.changeRadius} onEndEditing={() => void autosave.flush()} accessibilityLabel="実施期間の日数幅" />
        </View>
        {autosave.radiusError ? <Text style={styles.error}>{autosave.radiusError}</Text> : null}
        <View style={styles.settingBlock}>
          <Text style={styles.settingTitle}>負荷</Text>
          <View style={styles.chipRow}>{loadOptions.map((option) => <ChoiceChip key={option.id} label={option.label} selected={load === option.id} onPress={() => autosave.changeLoad(option.id)} />)}</View>
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingCopy}><Text style={styles.settingTitle}>休日を優先</Text><Text style={styles.body}>実施期間に設定した休日を含めます。</Text></View>
          <Switch value={holidayPriority} accessibilityLabel="休日を優先" onValueChange={autosave.changeHoliday} />
        </View>

        {chore.category === '洗濯' ? (
          <View style={styles.settingBlock}>
            <SectionHeading title="洗濯" level="subsection" />
            <Text style={styles.settingTitle}>基本の干し方</Text>
            <View style={styles.chipRow}>
              <ChoiceChip label="どちらでも" selected={dryingPreference === 'either'} onPress={() => autosave.changeDrying('either')} />
              <ChoiceChip label="外干し" selected={dryingPreference === 'outdoors'} onPress={() => autosave.changeDrying('outdoors')} />
              <ChoiceChip label="部屋干し" selected={dryingPreference === 'indoors'} onPress={() => autosave.changeDrying('indoors')} />
            </View>
          </View>
        ) : null}

        <SectionHeading title="前回の実施" level="subsection" />
        {latestCompletion
          ? <Text style={styles.body}>{formatJapaneseDate(latestCompletion, { year: true })}{state?.lastCompletedEstimated ? 'ごろ（概算）' : ''}</Text>
          : <Text style={styles.body}>前回の実施時期は未登録です。</Text>}
        <Text accessibilityLiveRegion="polite" style={autosave.status.phase === 'error' ? styles.error : styles.success}>
          {autosave.status.error ?? (autosave.status.phase === 'saving' || autosave.status.phase === 'pending' ? '保存中…' : autosave.status.phase === 'saved' ? '保存しました' : '変更は自動で保存されます。')}
        </Text>
        {autosave.status.phase === 'error' ? <AppButton title="保存を再試行" onPress={() => void autosave.flush()} variant="secondary" /> : null}
        {autosave.status.phase === 'error' && snapshot.sharing ? <AppButton title="最新の設定を読み直す" onPress={() => void onReload().catch(() => undefined)} variant="secondary" /> : null}
        <AppButton title="この家事の履歴を見る" onPress={() => void autosave.navigateAfterSave(() => router.push(snapshot.sharing
          ? { pathname: '/sharing/history', params: { choreId: chore.id, groupId: snapshot.sharing.groupId } }
          : { pathname: '/history', params: { choreId: chore.id, source: 'personal' } }))} variant="secondary" />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.caption, color: palette.muted },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 6 },
  settingCopy: { flex: 1, gap: 3 },
  settingTitle: { ...typography.control, color: palette.ink, fontWeight: '700' },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  settingBlock: { gap: 8, paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  error: { ...typography.caption, color: palette.warning },
  success: { ...typography.caption, color: palette.accent, fontWeight: '600' },
});
