import { router, useFocusEffect, usePreventRemove } from 'expo-router';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SettingsCheckbox } from '@/components/settings-checkbox';
import { SettingsPanel, SettingsSegments } from '@/components/settings-controls';
import { plannerColorsForScheme } from '@/components/planner-theme';
import { ChoreBook } from '@/components/chore-book';
import { createChoreSettingsDocument } from '@/features/settings/chore-settings-editor';
import type { ChoreSettingsEditor } from '@/features/settings/chore-settings-editor';
import { NumberInputField } from '@/components/number-input-field';
import { SettingsAudience } from '@/components/settings-audience';

import { AppButton, BackButton, ChoiceChip, Page, ScreenHeading, palette, typography } from '@/components/planner-ui';
import type { ChoreDefinition, ChoreLoad } from '@/domain/chores/types';
import { choreCadenceLabel, registeredChoreCycleDays } from '@/domain/chores/cycle-policy';
import { PlannerLoadState } from '@/components/planner-load-state';
import type { usePlannerData } from '@/hooks/use-planner-data';
import { updateChoreSettings } from '@/platform/storage/repository';
import type { PlannerSnapshot } from '@/platform/storage/repository';

import { useChoreSettingsAutosave } from '@/features/settings/use-chore-settings-autosave';
import type { ChoreSettingsPatch } from '@/domain/chores/settings-patch';
import { parseSettingInteger } from '@/domain/chores/settings-patch';
import { choreScheduleDefaults } from '@/domain/chores/schedule-defaults';
import { ScheduleResetAction } from '@/components/schedule-reset-action';
import { choreInAudience, type ChoreAudienceSelection } from '../chores/audience-selection';

const loadOptions: { id: ChoreLoad; label: string }[] = [
  { id: 'light', label: '軽い' }, { id: 'normal', label: '普通' }, { id: 'heavy', label: '重い' },
];

export function ChoreSettingsBook({ choreId, selection, data }: { choreId: string; selection?: ChoreAudienceSelection; data: Pick<ReturnType<typeof usePlannerData>, 'snapshot' | 'loading' | 'error' | 'refresh' | 'database'> }) {
  const { snapshot, error, refresh, database } = data;
  const [reloadVersion, setReloadVersion] = useState(0);
  const caches = useMemo(() => createChoreSettingsDocument(database), [database]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const leaving = useRef(false);
  const allowRemoval = useRef(() => {});
  const selectedId = selection ? choreInAudience(snapshot?.chores ?? [], selection) : choreId;
  const chore = snapshot?.chores.find((item) => item.id === selectedId);
  const leaveAfterSave = async (navigate: () => void, canNavigate = () => true) => {
    if (leaving.current) return; leaving.current = true; let departed = false;
    try {
      setSaveError(null);
      for (const [, cache] of caches.entries()) void cache.navigateAfterSave(() => {});
      if (!canNavigate()) { setSaveError('所属グループが変わりました。設定画面を開き直してください。'); return; }
      allowRemoval.current(); navigate(); departed = true;
    } catch { setSaveError('画面を移動できませんでした。もう一度お試しください。');
    } finally { if (!departed) leaving.current = false; }
  };
  const disablePrevention = usePreventRemove(true, ({ repeat }) => { void leaveAfterSave(repeat); });
  useLayoutEffect(() => { allowRemoval.current = disablePrevention; }, [disablePrevention]);
  useFocusEffect(useCallback(() => {
    leaving.current = false;
    for (const [, cache] of caches.entries()) cache.resumeNavigation();
    return () => { for (const [, cache] of caches.entries()) void cache.navigateAfterSave(() => {}); };
  }, [caches]));
  if (!snapshot) return <PlannerLoadState title="家事ごとの設定" message="設定を読み込んでいます。" error={error} retry={refresh} />;
  const rows = snapshot.chores.filter(item => !item.archived);
  if (!chore && rows.length) return <Page header={<BackButton onPress={() => void leaveAfterSave(() => router.back())} />}><ScreenHeading title="家事が見つかりません" /></Page>;
  const back = () => leaveAfterSave(() => router.back());
  return <ChoreBook chores={rows} selectedId={selectedId} title="家事ごとの設定" onBack={() => void back()} collapseSplits
    beforeCollapse={async item => {
      const cache = caches.entries().find(([id]) => id === item.id)?.[1];
      if (cache) void cache.navigateAfterSave(() => {});
      setSaveError(null); return true;
    }}
    titleAccessory={visible => <SettingsAudience groupName={snapshot.sharing ? snapshot.household.name : undefined} chore={visible} navigate={leaveAfterSave} />}
    header={saveError || error ? <Text accessibilityRole="alert" style={styles.error}>{saveError ?? error}</Text> : undefined}
    renderChore={(item, presentation) => {
      const cache = caches.get(item, snapshot.settings.frequencyMode, async (patch, base) => { if (await updateChoreSettings(database, item.id, patch, base)) await refresh(); }, snapshot.personalCadences?.[item.id]);
      return <ChoreSettingsContent key={`${item.id}:${reloadVersion}`} chore={item} snapshot={snapshot} error={null} cache={cache} hideHeading={presentation?.hideHeading}
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
  hideHeading = false,
}: {
  chore: ChoreDefinition;
  cache?: ChoreSettingsEditor;
  snapshot: PlannerSnapshot;
  error: string | null;
  savePatch: (patch: ChoreSettingsPatch, displayedBase: ChoreDefinition) => Promise<void>;
  onReload: () => Promise<void>;
  hideHeading?: boolean;
}) {
  const scheme = useColorScheme(); const colors = plannerColorsForScheme(scheme);
  const rowStyle = [styles.row, { borderBottomColor: colors.border }];
  const autosave = useChoreSettingsAutosave(chore, snapshot.settings.frequencyMode, savePatch, cache);
  const { cycleText, radiusText, load, holidayPriority, dryingPreference, enabled } = autosave.draft;
  const seasonal = chore.personalSchedulingKind === 'seasonal';
  const cadence = snapshot.personalCadences?.[chore.id];
  const automaticCycle = cadence?.automatic && cadence.days !== null;
  const cycleCaption = automaticCycle ? null
    : chore.requiresCycleSelection ? '周期を入力すると予定に追加できます。'
      : chore.applianceCareSource && chore.manufacturerRecommendedIntervalDays === undefined
        ? 'メーカー指定なし。周期を入力するまでは予定に追加されません。'
        : chore.manufacturerRecommendedIntervalDays !== undefined
          ? `メーカー推奨：${chore.manufacturerRecommendedIntervalDays}日`
          : chore.frequencyDaysByMode[snapshot.settings.frequencyMode] === undefined ? choreCadenceLabel(chore, snapshot.settings.frequencyMode) : null;

  return (
    <View style={styles.content}>
      {!hideHeading ? <Text accessibilityRole="header" style={styles.choreName}>{chore.name}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

      <SettingsPanel>
        <View style={rowStyle}>
          <View style={styles.settingCopy}>
            <Text style={styles.settingTitle}>予定に追加</Text>
          </View>
          <SettingsCheckbox value={enabled} accessibilityLabel="家事を有効にする" onValueChange={autosave.changeEnabled} disabled={chore.requiresCycleSelection && parseSettingInteger(cycleText, 1, Number.MAX_SAFE_INTEGER) === undefined} />
        </View>
        {seasonal ? <View style={rowStyle}><Text style={styles.settingTitle}>周期</Text><Text style={styles.body}>{choreCadenceLabel(chore, snapshot.settings.frequencyMode)}</Text></View> : <View style={rowStyle}>
          <View style={styles.settingCopy}>
            <View style={styles.titleLine}><Text style={styles.settingTitle}>周期</Text>{automaticCycle ? <Text style={styles.body}>自動調整</Text> : null}</View>
            {cycleCaption ? <Text style={styles.body}>{cycleCaption}</Text> : null}
          </View>
          <NumberInputField
            borderless
            value={cycleText}
            onChangeText={autosave.changeCycle}
            onEndEditing={() => void autosave.flush()}
            accessibilityLabel="家事周期の日数"
            placeholder={chore.requiresCycleSelection ? '入力' : registeredChoreCycleDays(chore, snapshot.settings.frequencyMode) === undefined ? '—' : undefined}
          />
        </View>}
        {autosave.cycleError ? <Text style={styles.error}>{autosave.cycleError}</Text> : null}
        {chore.schedulingNotes ? <Text style={styles.body}>{chore.schedulingNotes}</Text> : null}
        {chore.applianceId && chore.manufacturerRecommendedIntervalDays !== undefined
          && (chore.userIntervalDays ?? chore.recommendedCycleDays) !== undefined
          && (chore.userIntervalDays ?? chore.recommendedCycleDays) !== chore.manufacturerRecommendedIntervalDays ? (
            <AppButton title="メーカー推奨に戻す" onPress={autosave.resetCycle} variant="quiet" compact />
          ) : null}

        {!seasonal ? <View style={rowStyle}>
          <View style={styles.settingCopy}><Text style={styles.settingTitle}>実施期間の幅</Text></View>
          <NumberInputField borderless prefix="±" value={radiusText} onChangeText={autosave.changeRadius} onEndEditing={() => void autosave.flush()} accessibilityLabel="実施期間の日数幅" />
        </View> : null}
        {autosave.radiusError ? <Text style={styles.error}>{autosave.radiusError}</Text> : null}
        {chore.customPersonal ? <View style={rowStyle}><Text style={styles.settingTitle}>目安時間</Text>
          <NumberInputField borderless suffix="分" accessibilityLabel="家事の目安時間" value={autosave.draft.minutesText}
            onChangeText={autosave.changeMinutes} onEndEditing={() => void autosave.flush()} />
        </View> : null}
        {chore.customPersonal && parseSettingInteger(autosave.draft.minutesText, 1, 1440) === undefined ? <Text accessibilityRole="alert" style={styles.error}>目安時間は1〜1440分で入力してください。</Text> : null}
        <View style={rowStyle}>
          <Text style={styles.settingTitle}>負荷</Text>
          <SettingsSegments options={loadOptions} value={load} onValueChange={autosave.changeLoad} />
        </View>
        {!seasonal ? <View style={rowStyle}>
          <View style={styles.settingCopy}><Text style={styles.settingTitle}>休日を優先</Text></View>
          <SettingsCheckbox value={holidayPriority} accessibilityLabel="休日を優先" onValueChange={autosave.changeHoliday} />
        </View> : null}

        {chore.category === '洗濯' || chore.laundryDryingPreference !== undefined ? (
          <View style={rowStyle}>
            <Text style={styles.settingTitle}>干し方</Text>
            <View style={styles.chipRow}>
              <ChoiceChip label="どちらでも" selected={dryingPreference === 'either'} onPress={() => autosave.changeDrying('either')} />
              <ChoiceChip label="外干し" selected={dryingPreference === 'outdoors'} onPress={() => autosave.changeDrying('outdoors')} />
              <ChoiceChip label="部屋干し" selected={dryingPreference === 'indoors'} onPress={() => autosave.changeDrying('indoors')} />
            </View>
          </View>
        ) : null}

        {choreScheduleDefaults(chore) ? <ScheduleResetAction onReset={async () => { if (!await autosave.resetSchedule()) throw new Error('初期値を保存できませんでした。再試行してください。'); }} /> : null}

        {autosave.status.phase === 'error' ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{autosave.status.error ?? '設定を保存できませんでした。'}</Text> : null}
        {autosave.status.phase === 'error' ? <AppButton title="保存を再試行" onPress={() => void autosave.flush()} variant="secondary" /> : null}
        {autosave.status.phase === 'error' && snapshot.sharing ? <AppButton title="最新の設定を読み直す" onPress={() => void onReload().catch(() => undefined)} variant="secondary" /> : null}
      </SettingsPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: 8 }, choreName: { ...typography.section, color: palette.ink, fontWeight: '700', marginBottom: 2 },
  body: { ...typography.caption, color: palette.muted },
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 8, borderBottomWidth: 1 },
  settingCopy: { flex: 1, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8 },
  settingTitle: { ...typography.body, color: palette.ink },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 1, maxWidth: '80%', gap: 6 },
  error: { ...typography.caption, color: palette.warning },
});
