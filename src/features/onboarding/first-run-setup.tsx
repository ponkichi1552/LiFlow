import { FormTextInput as TextInput } from '../../components/form-text-input';
import { useLayoutEffect, useRef, useState, type ComponentRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from '@/components/screen-safe-area';
import { usePlannerData } from '@/hooks/use-planner-data';

import { AppButton, Card, ChoiceChip, SectionHeading, palette, typography } from '@/components/planner-ui';
import type { ChoreDefinition, FrequencyMode } from '@/domain/chores/types';
import { personalOnboardingChores } from '@/domain/chores/personal-catalog';
import { addDays, formatJapaneseDate, localDateFromDate } from '@/domain/scheduling/local-date';
import type { Weekday, WeatherLocation } from '@/domain/shared/types';
import { completeFirstSetup, nextInitialDateChoice } from '@/platform/storage/repository';
import { municipalityWeatherLocation } from '@/features/weather/municipality-search';
import type { WeatherRegionCandidate } from '@/features/weather/municipality-search';
import { LocationAttribution, WeatherAttribution } from '@/components/data-credits';
import { useMunicipalitySuggestions } from '@/features/weather/use-municipality-suggestions';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import type { WasteScheduleInput } from '@/features/waste/contracts';
import { WasteScheduleEditor } from '@/features/waste/waste-schedule-editor';
import { wasteScheduleDescription } from '@/features/waste/schedule-policy';
import { generateWasteCollectionDates } from '@/features/waste/weekly-scheduler';
import { useWasteTypeColor } from '@/features/waste/use-waste-type-color';
import { SettingsAction, SettingsGroup, SettingsPanel, SettingsSegments } from '../../components/settings-controls';
import { SettingsCheckbox } from '../../components/settings-checkbox';
import { SettingsHeader } from '../../components/settings-header';
import { WeekdayChoices } from '../../components/weekday-choices';
import { finishStartupDisplay } from '@/platform/diagnostics/startup-splash';

const modeOptions: { id: FrequencyMode; title: string }[] = [
  { id: 'frequent', title: 'こまめ' },
  { id: 'balanced', title: '適度' },
  { id: 'relaxed', title: '少なめ' },
];

const weekdayOptions: { id: Weekday; label: string }[] = [
  { id: 1, label: '月' }, { id: 2, label: '火' }, { id: 3, label: '水' }, { id: 4, label: '木' },
  { id: 5, label: '金' }, { id: 6, label: '土' }, { id: 7, label: '日' },
];
const setupStepCount = 2;
const budgetOptions = [{ id: '15', label: '15分' }, { id: '30', label: '30分' }, { id: '60', label: '60分' }, { id: 'none', label: '上限なし' }];
const timeOptions = {
  workday: [{ id: '1080-1200', label: '18–20時' }, { id: '1140-1260', label: '19–21時' }, { id: '1200-1320', label: '20–22時' }],
  holiday: [{ id: '540-720', label: '9–12時' }, { id: '540-1140', label: '9–19時' }, { id: '780-1080', label: '13–18時' }],
};

type PreviousChoice = 'today' | 'week' | 'month' | 'unknown';

export function FirstRunSetup({ snapshot, onComplete, loadError }: { snapshot: PlannerSnapshot; onComplete: () => Promise<void>; loadError?: string | null }) {
  useLayoutEffect(() => { finishStartupDisplay(); }, []);
  const wasteTypeColor = useWasteTypeColor();

  const { database } = usePlannerData();
  const availableChores = personalOnboardingChores(snapshot.chores);
  const [step, setStep] = useState(0);
  const [optional, setOptional] = useState<'previous' | 'weather' | 'waste' | null>(null);
  const [budget, setBudget] = useState({ workday: 'none', holiday: 'none' });
  const [bands, setBands] = useState({ workday: '1140-1260', holiday: '540-1140' });
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const go = (next: number, page: typeof optional = null) => { setStep(next); setOptional(page); scroll.current?.scrollTo({ y: 0, animated: false }); };

  const [mode, setMode] = useState(snapshot.settings.frequencyMode);
  const [restDays, setRestDays] = useState<Weekday[]>(snapshot.settings.restDays as Weekday[]);
  const [enabledChoreIds, setEnabledChoreIds] = useState(() =>
    new Set(availableChores.filter((chore) => chore.enabled).map((chore) => chore.id)),
  );
  const [previousChoices, setPreviousChoices] = useState<Record<string, PreviousChoice>>({});
  const notificationsEnabled = false;
  const [weatherRegion, setWeatherRegion] = useState(snapshot.settings.weatherLocation?.region ?? '');
  const [weatherLocation, setWeatherLocation] = useState<WeatherLocation | null>(snapshot.settings.weatherLocation ?? null);
  const [weatherSearchEnabled, setWeatherSearchEnabled] = useState(false);
  const [weatherCandidate, setWeatherCandidate] = useState<WeatherRegionCandidate | null>(null);
  const [weatherMessage, setWeatherMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const weatherSuggestions = useMunicipalitySuggestions(weatherRegion, weatherSearchEnabled);
  const [saving, setSaving] = useState(false);
  const [committed, setCommitted] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [wasteSchedules, setWasteSchedules] = useState<WasteScheduleInput[]>(() => [...snapshot.wasteSchedules]);
  const [editingWaste, setEditingWaste] = useState<WasteScheduleInput | undefined>();
  const wasteSequence = useRef(0);

  const toggleRestDay = (weekday: Weekday) => {
    setRestDays((current) => current.includes(weekday)
      ? current.filter((item) => item !== weekday)
      : [...current, weekday].sort() as Weekday[]);
  };

  const toggleChore = (choreId: string) => {
    setEnabledChoreIds((current) => {
      const next = new Set(current);
      if (next.has(choreId)) next.delete(choreId);
      else next.add(choreId);
      return next;
    });
  };

  const selectWeatherCandidate = (candidate: WeatherRegionCandidate) => {
    setWeatherCandidate(candidate);
    setWeatherLocation(municipalityWeatherLocation(candidate, weatherRegion));
    setWeatherMessage({ text: `「${candidate.label}」を天気に使う地域として選択しました。`, kind: 'success' });
  };

  const capacity = (kind: 'workday' | 'holiday') => {
    const [startMinute, endMinute] = bands[kind].split('-').map(Number);
    return { ...(budget[kind] === 'none' ? {} : { maximumMinutes: Number(budget[kind]) }), allowedBands: [{ startMinute, endMinute }] };
  };
  const saveSetup = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const today = localDateFromDate(new Date());
      const previousDates: Record<string, { date?: `${number}-${number}-${number}`; estimated?: boolean; unknownReason?: 'unknown' | 'skipped' }> = {};
      for (const chore of availableChores) {
        previousDates[chore.id] = nextInitialDateChoice(today, previousChoices[chore.id] ?? 'unknown');
      }
      await completeFirstSetup(database, {
        frequencyMode: mode,
        restDays,
        enabledChoreIds: [...enabledChoreIds],
        previousDates,
        notificationsEnabled,
        weatherLocation,
        wasteSchedules,
        dayTypes: { workday: capacity('workday'), holiday: capacity('holiday') },
      });
      setCommitted(true);
      await onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '初回設定を保存できませんでした');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const enabledChores = availableChores.filter((chore) => enabledChoreIds.has(chore.id));

  if (committed) return <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']} onLayout={finishStartupDisplay}>
    <View style={styles.content}>
      <Text style={styles.body}>初期設定は保存済みです。</Text>
      {loadError || error ? <Text accessibilityRole="alert" style={styles.error}>{loadError ?? error}</Text> : null}
      <AppButton title="表示を再読込" disabled={saving} onPress={() => void onComplete().catch(cause => setError(cause instanceof Error ? cause.message : '表示を更新できませんでした。'))} />
    </View>
  </SafeAreaView>;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']} onLayout={finishStartupDisplay}>
      <SettingsHeader backAccessibilityLabel="戻る" title={optional ? optional === 'previous' ? '前回の実施' : optional === 'weather' ? '天気予報' : 'ゴミ収集日' : '初回設定'} onBack={() => go(optional ? 1 : 0)} hideBack={!optional && step === 0} />
      <ScrollView ref={scroll}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
        {!optional ? <>
          <View style={styles.progressRow}>{Array.from({ length: setupStepCount }, (_, index) => <View key={index} style={[styles.progressDot, index <= step && styles.progressDotActive]} />)}</View>
          <Text style={styles.eyebrow}>{step + 1} / {setupStepCount}</Text>
          <Text style={styles.title}>{step === 0 ? '家事を選ぶ' : '生活リズム'}</Text>
        </> : null}
        {!optional && step === 0 ? <>
          <Text style={styles.body}>普段行う家事を選んでください。</Text>
          <SettingsPanel>{availableChores.map(chore => <SetupChoreRow key={chore.id} chore={chore} selected={enabledChoreIds.has(chore.id)} onPress={() => toggleChore(chore.id)} />)}</SettingsPanel>
          <View style={styles.chipRow}>
            <SettingsAction title="すべて選択" compact intent="auxiliary" onPress={() => setEnabledChoreIds(new Set(availableChores.map(chore => chore.id)))} disabled={enabledChoreIds.size === availableChores.length} />
            <SettingsAction title="選択をすべて外す" compact intent="auxiliary" onPress={() => setEnabledChoreIds(new Set())} disabled={!enabledChoreIds.size} />
          </View>
        </> : null}
        {!optional && step === 1 ? <>
          <SettingsGroup compact title="休日"><WeekdayChoices options={weekdayOptions} selected={restDays} disabled={saving} onToggle={day => toggleRestDay(day as Weekday)} />
            <Text style={styles.hint}>普段の休みを選択。ない場合は選ばず進めます。</Text></SettingsGroup>
          <SettingsGroup compact title="家事の頻度"><SettingsSegments fullWidth value={mode} options={modeOptions.map(option => ({ id: option.id, label: option.title }))} onValueChange={value => setMode(value as FrequencyMode)} disabled={saving} /></SettingsGroup>
          <SettingsGroup compact title="1日に使える時間">{(['workday', 'holiday'] as const).map(kind => <View key={kind} style={styles.presetSection}>
            <Text style={styles.label}>{kind === 'workday' ? '平日' : '休日'}</Text>
            <SettingsSegments fullWidth value={budget[kind]} options={budgetOptions} onValueChange={value => setBudget(current => ({ ...current, [kind]: value }))} disabled={saving} />
          </View>)}</SettingsGroup>
          <SettingsGroup compact title="家事ができる時間帯">{(['workday', 'holiday'] as const).map(kind => <View key={kind} style={styles.presetSection}>
            <Text style={styles.label}>{kind === 'workday' ? '平日' : '休日'}</Text>
            <SettingsSegments fullWidth value={bands[kind]} options={timeOptions[kind]} onValueChange={value => setBands(current => ({ ...current, [kind]: value }))} disabled={saving} />
          </View>)}</SettingsGroup>
          <Text style={styles.hint}>時刻や上限は、あとから細かく変更できます。</Text>
          <SectionHeading title="必要なら設定" level="subsection" />
          {([{ id: 'previous', label: '前回の実施' }, { id: 'weather', label: '天気予報' }, { id: 'waste', label: 'ゴミ収集日' }] as const).map(item => <SettingsAction key={item.id} title={item.label} intent="auxiliary" onPress={() => go(1, item.id)} disabled={saving} />)}
        </> : null}
        {optional === 'previous' ? (
          <>
            <Text style={styles.body}>分かる家事だけ選んでください。</Text>
            {enabledChores.length === 0 ? <Text style={styles.hint}>家事が選ばれていません。あとから家事一覧で有効にできます。</Text> : null}
            <View style={styles.choreList}>
              {enabledChores.map((chore) => (
                <View key={chore.id} style={styles.previousCard}>
                  <Text style={styles.choreName}>{chore.name}</Text>
                  <View style={styles.chipRow}>
                    {([
                      ['today', '今日'], ['week', '1週間前'], ['month', '1か月前'], ['unknown', '不明'],
                    ] as [PreviousChoice, string][]).map(([choice, label]) => (
                      <ChoiceChip
                        key={choice}
                        label={label}
                        selected={(previousChoices[chore.id] ?? 'unknown') === choice}
                        onPress={() => setPreviousChoices((current) => ({ ...current, [chore.id]: choice }))}
                      />
                    ))}
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {optional === 'weather' ? (
          <>
            <Text style={styles.body}>洗濯の予定に使う市区町村を選んでください。</Text>
            <View style={styles.weatherSearch}>
              <TextInput
                value={weatherRegion}
                editable={!saving}
                onChangeText={(value) => {
                  setWeatherRegion(value);
                  setWeatherLocation(null);
                  setWeatherCandidate(null);
                  setWeatherSearchEnabled(true);
                  setWeatherMessage(null);
                }}
                placeholder="例：横浜市、札幌市"
                placeholderTextColor={palette.muted}
                style={styles.regionInput}
                accessibilityLabel="天気予報に使う市区町村"
                returnKeyType="done"
              />
                  </View>
            {weatherSuggestions.candidates.length > 0 ? (
              <View style={styles.regionResults}>
                <Text style={styles.label}>候補を選択</Text>
                {weatherSuggestions.candidates.map((candidate) => (
                  <Pressable
                    key={candidate.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: weatherCandidate?.id === candidate.id }}
                    onPress={() => selectWeatherCandidate(candidate)}
                    style={[styles.regionCandidate, weatherCandidate?.id === candidate.id && styles.regionCandidateSelected]}>
                    <Text style={styles.regionCandidateText}>{candidate.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {weatherSuggestions.status === 'empty'
              ? <Text style={styles.hint}>市区町村が見つかりませんでした。市区町村名を変えてください。</Text>
              : null}
            {weatherLocation ? <Text style={styles.selectedRegion}>天気に使う地域：{weatherLocation.displayName}</Text> : null}
            <WeatherAttribution />
            <LocationAttribution />
            {weatherMessage ? <Text style={weatherMessage.kind === 'success' ? styles.success : styles.error}>{weatherMessage.text}</Text> : null}

          </>
        ) : null}

        {optional === 'waste' ? (
          <>

            <WasteScheduleEditor key={editingWaste?.id ?? 'new'} initial={editingWaste} disabled={saving}
              onCancel={editingWaste ? () => setEditingWaste(undefined) : undefined}
              onSubmit={async (schedule) => {
                const draft = { ...schedule, id: schedule.id ?? `setup-waste-${Date.now()}-${wasteSequence.current++}` };
                setWasteSchedules((current) => current.some((item) => item.id === draft.id)
                  ? current.map((item) => item.id === draft.id ? draft : item) : [...current, draft]);
                setEditingWaste(undefined);
              }} />
            {wasteSchedules.length ? <SectionHeading title="登録済み" trailing={<Text style={styles.label}>{wasteSchedules.length}種類</Text>} /> : null}
            {!wasteSchedules.length ? <Text style={styles.hint}>未登録</Text> : wasteSchedules.map((schedule) => (
              <Card key={schedule.id} style={{ borderLeftColor: wasteTypeColor(schedule.label), borderLeftWidth: 4 }}>
                <Text style={[styles.choreName, { color: wasteTypeColor(schedule.label) }]}>{schedule.label}</Text>
                <Text style={styles.hint}>{wasteScheduleDescription(schedule)}</Text>
                <View style={styles.chipRow}>
                  <AppButton title={`${schedule.label}を編集`} onPress={() => setEditingWaste(schedule)} variant="secondary" compact />
                  <AppButton title={`${schedule.label}を削除`} onPress={() => {
                    setWasteSchedules((current) => current.filter((item) => item.id !== schedule.id));
                    if (editingWaste?.id === schedule.id) setEditingWaste(undefined);
                  }} variant="danger" compact />
                </View>
              </Card>
            ))}
            {wasteSchedules.length ? <SectionHeading title="次の収集日" /> : null}
            {wasteSchedules.flatMap((schedule) => generateWasteCollectionDates({ ...schedule, id: schedule.id!, householdId: snapshot.household.id }, localDateFromDate(new Date()), addDays(localDateFromDate(new Date()), 35)))
              .sort((left, right) => left.date.localeCompare(right.date)).slice(0, 4)
              .map((occurrence) => <Text key={`${occurrence.scheduleId}-${occurrence.date}`} style={[styles.hint, { color: wasteTypeColor(occurrence.label) }]}>{formatJapaneseDate(occurrence.date, { weekday: true })}　{occurrence.label}</Text>)}
          </>
        ) : null}


      </ScrollView>

      <View style={styles.footer}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {optional ? <SettingsAction title="設定を続ける" intent="primary" onPress={() => go(1)} disabled={saving} />
          : step === 0 ? <SettingsAction title="次へ" intent="primary" onPress={() => go(1)} disabled={saving} />
            : <SettingsAction title={saving ? '設定中…' : '設定して始める'} intent="primary" onPress={() => void saveSetup()} disabled={saving} />}

      </View>
    </SafeAreaView>
  );
}

function SetupChoreRow({ chore, selected, onPress }: { chore: ChoreDefinition; selected: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={onPress} style={styles.choreRow}>
      <View style={styles.choreCopy}>
        <Text style={styles.choreName}>{chore.name}</Text>
      </View>
      <View pointerEvents="none" accessible={false}><SettingsCheckbox accessibilityLabel={`${chore.name}を予定に追加`} value={selected} onValueChange={onPress} /></View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  scroll: { flex: 1 },
  content: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 22, gap: 16 },
  progressRow: { flexDirection: 'row', gap: 6 },
  progressDot: { flex: 1, height: 4, borderRadius: 2, backgroundColor: palette.border },
  progressDotActive: { backgroundColor: palette.accent },
  eyebrow: { ...typography.caption, color: palette.accent, fontWeight: '700', letterSpacing: 1.2 },
  title: { ...typography.title, color: palette.ink, fontWeight: '800', marginTop: -7 },
  body: { ...typography.body, color: palette.muted, marginTop: -7 },
  label: { ...typography.label, color: palette.ink, fontWeight: '700' },
  presetSection: { gap: 8, paddingVertical: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  hint: { ...typography.caption, color: palette.muted },
  choreList: { gap: 7 },
  choreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, paddingVertical: 4 },
  choreCopy: { flex: 1, gap: 3, paddingRight: 10 },
  choreName: { ...typography.subheading, color: palette.ink, fontWeight: '600' },
  previousCard: { gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, paddingBottom: 12 },
  weatherSearch: { gap: 10 },
  regionInput: { ...typography.body, minHeight: 54, borderWidth: 1, borderColor: palette.accent, borderRadius: 14, paddingHorizontal: 14, color: palette.ink, backgroundColor: palette.surface },
  regionResults: { gap: 8 },
  regionCandidate: { minHeight: 47, justifyContent: 'center', borderWidth: 1, borderColor: palette.border, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10, backgroundColor: palette.surface },
  regionCandidateSelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  regionCandidateText: { ...typography.label, color: palette.ink, fontWeight: '600' },
  selectedRegion: { ...typography.label, color: palette.accent, fontWeight: '700' },
  error: { ...typography.label, color: palette.warning },
  success: { ...typography.label, color: palette.accent, fontWeight: '600' },
  footer: { alignItems: 'stretch', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 8 },
});
