import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from 'react';
import { BackHandler, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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
import type { PlannerSnapshot, SetupSubmission } from '@/platform/storage/repository';
import type { WasteScheduleInput } from '@/features/waste/contracts';
import { WasteScheduleEditor, type WasteSetupEditor, type WasteSetupStatus } from '@/features/waste/waste-schedule-editor';
import { wasteScheduleDescription } from '@/features/waste/schedule-policy';
import { generateWasteCollectionDates } from '@/features/waste/weekly-scheduler';
import { useWasteTypeColor } from '@/features/waste/use-waste-type-color';
import { SettingsAction, SettingsGroup, SettingsLabel, SettingsPanel, SettingsSegments } from '../../components/settings-controls';
import { SettingsCheckbox } from '../../components/settings-checkbox';
import { SettingsHeader } from '../../components/settings-header';
import { SearchField } from '../../components/search-field';
import { WeekdayChoices } from '../../components/weekday-choices';
import { finishStartupDisplay } from '@/platform/diagnostics/startup-splash';
import { retryPlannerDisplayRead } from '@/platform/storage/planner-read-retry';
import { SettingsList, SettingsRow } from '@/features/settings/settings-navigation';

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
const capacityDays = [{ kind: 'workday', label: '休日以外' }, { kind: 'holiday', label: '休日' }] as const;
const optionalTitles = { previous: '前回の実施', weather: '天気予報', waste: 'ゴミ収集日', capacity: '時間帯・上限' } as const;

type PreviousChoice = 'today' | 'week' | 'month' | 'unknown';

export function FirstRunSetup({ snapshot, onComplete, loadError }: { snapshot: PlannerSnapshot; onComplete: () => Promise<void>; loadError?: string | null }) {
  const { database } = usePlannerData();
  return <FirstRunSetupForm snapshot={snapshot} onComplete={onComplete} loadError={loadError} persist={submission => completeFirstSetup(database, submission)} />;
}

export type FirstRunPage = 'chores' | 'rhythm' | keyof typeof optionalTitles;
export function FirstRunSetupForm({ snapshot, onComplete, loadError, persist, initialPage = 'chores', referenceDate, onExit, exitAccessibilityLabel = 'UI確認用データ一覧へ戻る' }: {
  snapshot: PlannerSnapshot; onComplete: () => Promise<void>; loadError?: string | null;
  persist(submission: SetupSubmission): Promise<void>; initialPage?: FirstRunPage; referenceDate?: PlannerSnapshot['today']; onExit?: () => void; exitAccessibilityLabel?: string;
}) {
  useLayoutEffect(() => { finishStartupDisplay(); }, []);
  const { width, fontScale } = useWindowDimensions();
  const capacityLabelWidth = Math.ceil(70 * Math.max(1, fontScale));
  const stackCapacity = (width - 40) / Math.max(1, fontScale) < 250;
  const wasteTypeColor = useWasteTypeColor();

  const availableChores = personalOnboardingChores(snapshot.chores);
  const [step, setStep] = useState(initialPage === 'chores' ? 0 : 1);
  const [optional, setOptional] = useState<keyof typeof optionalTitles | null>(initialPage === 'chores' || initialPage === 'rhythm' ? null : initialPage);
  const [budget, setBudget] = useState({ workday: 'none', holiday: 'none' });
  const [bands, setBands] = useState({ workday: '1140-1260', holiday: '540-1140' });
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const [mode, setMode] = useState(snapshot.settings.frequencyMode);
  const [restDays, setRestDays] = useState<Weekday[]>(snapshot.settings.restDays as Weekday[]);
  const [enabledChoreIds, setEnabledChoreIds] = useState(() =>
    new Set(availableChores.filter((chore) => chore.enabled).map((chore) => chore.id)),
  );
  const [previousChoices, setPreviousChoices] = useState<Record<string, PreviousChoice>>({});
  const notificationsEnabled = false;
  const [weatherRegion, setWeatherRegion] = useState('');
  const [weatherLocation, setWeatherLocation] = useState<WeatherLocation | null>(snapshot.settings.weatherLocation ?? null);
  const [weatherSearchEnabled, setWeatherSearchEnabled] = useState(false);
  const searchForWeather = weatherSearchEnabled || !weatherLocation;
  const weatherSuggestions = useMunicipalitySuggestions(weatherRegion, optional === 'weather' && searchForWeather);
  const leaveWeatherLabel = !weatherLocation ? '選ばずに戻る' : weatherSearchEnabled ? '変更せずに戻る' : 'この地域で戻る';
  const go = useCallback((next: number, page: typeof optional = null) => {
    if (optional === 'weather') Keyboard.dismiss();
    if (page === 'weather') {
      setWeatherRegion('');
      setWeatherSearchEnabled(false);
    }
    setStep(next);
    setOptional(page);
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [optional]);
  useEffect(() => {
    if (Platform.OS !== 'android' || optional !== 'capacity') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      go(1);
      return true;
    });
    return () => subscription.remove();
  }, [go, optional]);
  const [saving, setSaving] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [openingHome, setOpeningHome] = useState(false);
  const [homeUnavailable, setHomeUnavailable] = useState(false);
  const openHome = useRef(onComplete);
  useEffect(() => { openHome.current = onComplete; }, [onComplete]);
  useEffect(() => {
    if (!openingHome) return;
    return retryPlannerDisplayRead(async () => { await openHome.current(); return true; }, recovered => {
      setHomeUnavailable(!recovered);
      setOpeningHome(false);
    });
  }, [openingHome]);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [wasteSchedules, setWasteSchedules] = useState<WasteScheduleInput[]>(() => [...snapshot.wasteSchedules]);
  const [editingWaste, setEditingWaste] = useState<WasteScheduleInput | undefined>();
  const [wasteStatus, setWasteStatus] = useState<WasteSetupStatus>('idle');
  const wasteSubmit = useRef<() => Promise<boolean>>(undefined);
  const [wasteEditor] = useState<WasteSetupEditor>(() => ({
    drafts: new Map(), setStatus: setWasteStatus,
    registerSubmit(submit) {
      wasteSubmit.current = submit;
      return () => { if (wasteSubmit.current === submit) wasteSubmit.current = undefined; };
    },
  }));
  const wasteSequence = useRef(0);
  const finishWaste = async () => {
    if (wasteStatus === 'idle' || (wasteStatus === 'ready' && await wasteSubmit.current?.())) go(1);
  };

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
    setWeatherLocation(municipalityWeatherLocation(candidate, weatherRegion));
    setWeatherRegion('');
    setWeatherSearchEnabled(false);
    Keyboard.dismiss();
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
      const today = referenceDate ?? localDateFromDate(new Date());
      const previousDates: Record<string, { date?: `${number}-${number}-${number}`; estimated?: boolean; unknownReason?: 'unknown' | 'skipped' }> = {};
      for (const chore of availableChores) {
        previousDates[chore.id] = nextInitialDateChoice(today, previousChoices[chore.id] ?? 'unknown');
      }
      await persist({
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
      try { await onComplete(); }
      catch { setOpeningHome(true); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '初回設定を保存できませんでした');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const enabledChores = availableChores.filter((chore) => enabledChoreIds.has(chore.id));
  const capacitySummary = capacityDays.map(({ kind, label }) => {
    const band = timeOptions[kind].find(option => option.id === bands[kind])?.label ?? '';
    const limit = budget[kind] === 'none' ? '1日の上限なし' : `1日${budget[kind]}分まで`;
    return { label, value: `${band}・${limit}` };
  });

  if (committed) return <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']} onLayout={finishStartupDisplay}>
    {onExit ? <SettingsHeader title="初回設定" onBack={onExit} backAccessibilityLabel="UI確認用データ一覧へ戻る" /> : null}
    <View style={styles.content}>
      {homeUnavailable || loadError && !openingHome
        ? <Text accessibilityRole="alert" style={styles.error}>端末に保存した家事を表示できませんでした。</Text>
        : <Text style={styles.body}>家事を読み込んでいます。</Text>}
    </View>
  </SafeAreaView>;

  return <KeyboardAvoidingView style={styles.scroll} enabled={optional === 'weather'} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']} onLayout={finishStartupDisplay}>
      <SettingsHeader backAccessibilityLabel={!optional && step === 0 && onExit ? exitAccessibilityLabel : '戻る'} title={optional ? optionalTitles[optional] : '初回設定'}
        onBack={!optional && step === 0 && onExit ? onExit : () => go(optional ? 1 : 0)}
        backDisabled={saving || optional === 'waste' && wasteStatus === 'saving'} hideBack={!onExit && !optional && step === 0} />
      <ScrollView ref={scroll}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
        {!optional ? <View style={styles.stepHeading}>
          <Text accessibilityRole="header" style={styles.title}>{step === 0 ? '普段行う家事を選ぶ' : '生活リズム'}</Text>
          <Text style={styles.stepNumber}>{step + 1} / {setupStepCount}</Text>
        </View> : null}
        {!optional && step === 0 ? <>
          <SettingsPanel>{availableChores.map(chore => <SetupChoreRow key={chore.id} chore={chore} selected={enabledChoreIds.has(chore.id)} onPress={() => toggleChore(chore.id)} />)}</SettingsPanel>
          <View style={styles.chipRow}>
            <SettingsAction title="すべて選択" compact intent="auxiliary" onPress={() => setEnabledChoreIds(new Set(availableChores.map(chore => chore.id)))} disabled={enabledChoreIds.size === availableChores.length} />
            <SettingsAction title="選択をすべて外す" compact intent="auxiliary" onPress={() => setEnabledChoreIds(new Set())} disabled={!enabledChoreIds.size} />
          </View>
        </> : null}
        {!optional && step === 1 ? <>
          <View style={styles.rhythmSection}>
            <SettingsLabel>休日</SettingsLabel>
            <WeekdayChoices options={weekdayOptions} selected={restDays} disabled={saving} onToggle={day => toggleRestDay(day as Weekday)} />
            <Text style={styles.hint}>休みが決まっていなければ選ばずに進めます。</Text>
          </View>
          <View style={styles.rhythmSection}>
            <SettingsLabel>家事の頻度</SettingsLabel>
            <SettingsSegments fullWidth tone="quiet" value={mode} options={modeOptions.map(option => ({ id: option.id, label: option.title }))} onValueChange={value => setMode(value as FrequencyMode)} disabled={saving} />
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="時間帯・上限を変更" accessibilityValue={{ text: capacitySummary.map(row => `${row.label}、${row.value}`).join('。') }}
            accessibilityState={{ disabled: saving }} disabled={saving} onPress={() => go(1, 'capacity')} style={({ pressed }) => [styles.capacitySummary, pressed && styles.capacityPressed]}>
            <View style={styles.capacityHeader}><Text style={styles.label}>時間帯・上限</Text><Text style={styles.capacityAction}>変更</Text></View>
            {capacitySummary.map(({ label, value }) => <View key={label} style={[styles.capacityRow, stackCapacity && styles.capacityRowStacked]}>
              <Text style={[styles.capacityDay, !stackCapacity && { width: capacityLabelWidth }]}>{label}</Text>
              <Text style={styles.capacityValue}>{value}</Text>
            </View>)}
          </Pressable>
          <View style={styles.rhythmSection}>
            <SettingsLabel>任意設定</SettingsLabel>
            <SettingsList>
              {([{ id: 'previous', label: '前回の実施' }, { id: 'weather', label: '天気予報' }, { id: 'waste', label: 'ゴミ収集日' }] as const).map(item => <SettingsRow key={item.id} title={item.label} onPress={() => go(1, item.id)} disabled={saving} />)}
            </SettingsList>
          </View>
        </> : null}
        {optional === 'capacity' ? capacityDays.map(({ kind, label }) => <SettingsGroup key={kind} title={label}>
          <View style={styles.presetSection}>
            <Text style={styles.label}>家事ができる時間帯</Text>
            <SettingsSegments fullWidth value={bands[kind]} options={timeOptions[kind]} onValueChange={value => setBands(current => ({ ...current, [kind]: value }))} disabled={saving} />
          </View>
          <View style={styles.presetSection}>
            <Text style={styles.label}>1日の上限</Text>
            <SettingsSegments fullWidth value={budget[kind]} options={budgetOptions} onValueChange={value => setBudget(current => ({ ...current, [kind]: value }))} disabled={saving} />
          </View>
        </SettingsGroup>) : null}
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
            {weatherLocation ? <SettingsGroup compact title="天気に使う地域">
              <Text style={styles.choreName}>{weatherLocation.displayName}</Text>
              {!weatherSearchEnabled ? <SettingsAction title="地域を変更" intent="auxiliary" onPress={() => setWeatherSearchEnabled(true)} disabled={saving} /> : null}
            </SettingsGroup> : null}
            {searchForWeather ? <>
              <SearchField value={weatherRegion} editable={!saving} onChangeText={setWeatherRegion}
                placeholder="市区町村名で検索" accessibilityLabel="天気予報に使う市区町村" />
              {weatherSuggestions.candidates.length ? <View style={styles.regionResults}>
                {weatherSuggestions.candidates.map(candidate => <Pressable key={candidate.id} accessibilityRole="button"
                  onPress={() => selectWeatherCandidate(candidate)} style={styles.regionCandidate}>
                  <Text style={styles.regionCandidateText}>{candidate.label}</Text>
                </Pressable>)}
              </View> : null}
              {weatherSuggestions.status === 'empty' ? <Text style={styles.hint}>市区町村が見つかりませんでした。</Text> : null}
              {weatherLocation ? <SettingsAction title="地域を設定しない" intent="auxiliary" onPress={() => {
                setWeatherLocation(null);
                setWeatherRegion('');
                setWeatherSearchEnabled(false);
                Keyboard.dismiss();
              }} disabled={saving} /> : null}
            </> : null}
            <WeatherAttribution />
            <LocationAttribution />
          </>
        ) : null}

        {optional === 'waste' ? (
          <>

            <WasteScheduleEditor key={editingWaste?.id ?? 'new'} initial={editingWaste} disabled={saving} setup={wasteEditor}
              onCancel={editingWaste ? () => { wasteEditor.drafts.delete(editingWaste.id ?? ''); setEditingWaste(undefined); } : undefined}
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
                    wasteEditor.drafts.delete(schedule.id ?? '');
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
        {optional === 'waste' ? <SettingsAction title={wasteStatus === 'saving' ? '保存中…' : wasteStatus === 'ready' ? editingWaste ? '変更を保存して戻る' : '収集日を追加して戻る' : '設定を続ける'}
          intent="primary" onPress={() => void finishWaste()} disabled={saving || wasteStatus === 'saving'} />
          : optional ? <SettingsAction title={optional === 'weather' ? leaveWeatherLabel : '設定を続ける'} intent="primary" onPress={() => go(1)} disabled={saving} />
          : step === 0 ? <SettingsAction title="次へ" intent="primary" onPress={() => go(1)} disabled={saving} />
            : <SettingsAction title={saving ? '設定中…' : '設定して始める'} intent="primary" onPress={() => void saveSetup()} disabled={saving} />}

      </View>
    </SafeAreaView>
  </KeyboardAvoidingView>;
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
  stepHeading: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  stepNumber: { ...typography.caption, color: palette.muted },
  title: { ...typography.title, color: palette.ink, fontWeight: '800', flex: 1 },
  body: { ...typography.body, color: palette.muted, marginTop: -7 },
  label: { ...typography.label, color: palette.ink, fontWeight: '700' },
  rhythmSection: { gap: 8 },
  capacitySummary: { minHeight: 44, gap: 7, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  capacityPressed: { backgroundColor: palette.accentSoft },
  capacityHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  capacityAction: { ...typography.label, color: palette.accent },
  capacityRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  capacityRowStacked: { flexDirection: 'column', alignItems: 'stretch', gap: 2 },
  capacityDay: { ...typography.caption, fontWeight: '600', color: palette.ink, flexShrink: 0 },
  capacityValue: { ...typography.caption, color: palette.ink, flexShrink: 1 },
  presetSection: { gap: 8, paddingVertical: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  hint: { ...typography.caption, color: palette.muted },
  choreList: { gap: 7 },
  choreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, paddingVertical: 4 },
  choreCopy: { flex: 1, gap: 3, paddingRight: 10 },
  choreName: { ...typography.subheading, color: palette.ink, fontWeight: '600' },
  previousCard: { gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, paddingBottom: 12 },
  regionResults: { gap: 8 },
  regionCandidate: { minHeight: 47, justifyContent: 'center', borderWidth: 1, borderColor: palette.border, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10, backgroundColor: palette.surface },
  regionCandidateText: { ...typography.label, color: palette.ink, fontWeight: '600' },
  error: { ...typography.label, color: palette.warning },
  footer: { alignItems: 'stretch', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 8 },
});
