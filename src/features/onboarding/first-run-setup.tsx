import { FormTextInput as TextInput } from '../../components/form-text-input';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { usePlannerData } from '@/hooks/use-planner-data';

import { AppButton, BackButton, Card, ChoiceChip, NavigationHeader, SectionHeading, palette, typography } from '@/components/planner-ui';
import type { ChoreDefinition, FrequencyMode } from '@/domain/chores/types';
import { addDays, formatJapaneseDate, localDateFromDate } from '@/domain/scheduling/local-date';
import type { Weekday, WeatherLocation } from '@/domain/shared/types';
import { completeFirstSetup, nextInitialDateChoice } from '@/platform/storage/repository';
import { ExpoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';
import type { WeatherRegionCandidate } from '@/features/weather/open-meteo-geocoder';
import { LocationAttribution, WeatherAttribution } from '@/components/data-credits';
import { useMunicipalitySuggestions } from '@/features/weather/use-municipality-suggestions';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import type { WasteScheduleInput } from '@/features/waste/contracts';
import { WasteScheduleEditor } from '@/features/waste/waste-schedule-editor';
import { wasteScheduleDescription } from '@/features/waste/schedule-policy';
import { generateWasteCollectionDates } from '@/features/waste/weekly-scheduler';
import { useWasteTypeColor } from '@/features/waste/use-waste-type-color';

const modeOptions: { id: FrequencyMode; title: string }[] = [
  { id: 'frequent', title: 'こまめ' },
  { id: 'balanced', title: '普通' },
  { id: 'relaxed', title: '最低限' },
];

const weekdayOptions: { id: Weekday; label: string }[] = [
  { id: 1, label: '月' }, { id: 2, label: '火' }, { id: 3, label: '水' }, { id: 4, label: '木' },
  { id: 5, label: '金' }, { id: 6, label: '土' }, { id: 7, label: '日' },
];
const notificationGateway = new ExpoLocalNotificationGateway();
const setupStepCount = 6;

type PreviousChoice = 'today' | 'week' | 'month' | 'unknown';

export function FirstRunSetup({ snapshot, onComplete, loadError }: { snapshot: PlannerSnapshot; onComplete: () => Promise<void>; loadError?: string | null }) {
  const wasteTypeColor = useWasteTypeColor();

  const { database } = usePlannerData();
  const availableChores = snapshot.chores.filter((chore) => !chore.archived);
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState(snapshot.settings.frequencyMode);
  const [restDays, setRestDays] = useState<Weekday[]>(snapshot.settings.restDays as Weekday[]);
  const [enabledChoreIds, setEnabledChoreIds] = useState(() =>
    new Set(availableChores.filter((chore) => chore.enabled).map((chore) => chore.id)),
  );
  const [previousChoices, setPreviousChoices] = useState<Record<string, PreviousChoice>>({});
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    snapshot.settings.notificationsEnabled,
  );
  const [weatherRegion, setWeatherRegion] = useState(snapshot.settings.weatherLocation?.region ?? '');
  const [weatherLocation, setWeatherLocation] = useState<WeatherLocation | null>(snapshot.settings.weatherLocation ?? null);
  const [weatherSearchEnabled, setWeatherSearchEnabled] = useState(false);
  const [weatherCandidate, setWeatherCandidate] = useState<WeatherRegionCandidate | null>(null);
  const [weatherMessage, setWeatherMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const weatherSuggestions = useMunicipalitySuggestions(weatherRegion, weatherSearchEnabled);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [wasteSchedules, setWasteSchedules] = useState<WasteScheduleInput[]>(() => [...snapshot.wasteSchedules]);
  const [editingWaste, setEditingWaste] = useState<WasteScheduleInput | undefined>();
  const wasteSequence = useRef(0);

  useEffect(() => {
    let mounted = true;
    void notificationGateway.requestPermission()
      .then((granted) => {
        if (mounted) setNotificationsEnabled(granted);
      })
      .catch(() => {
        if (mounted) setNotificationsEnabled(false);
      });
    return () => { mounted = false; };
  }, []);

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
    setWeatherLocation({
      region: weatherRegion.trim(),
      displayName: candidate.label,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
    });
    setWeatherMessage({ text: `「${candidate.label}」を天気に使う地域として選択しました。`, kind: 'success' });
  };

  const saveSetup = async (skipWasteSetup: boolean) => {
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
        wasteSchedules: skipWasteSetup ? [] : wasteSchedules,
      });
      await onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '初回設定を保存できませんでした');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const enabledChores = availableChores.filter((chore) => enabledChoreIds.has(chore.id));

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      {step > 0 ? <NavigationHeader><BackButton accessibilityLabel="戻る" onPress={() => setStep(current => current - 1)} disabled={saving} /></NavigationHeader> : null}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
        <View style={styles.progressRow}>
          {Array.from({ length: setupStepCount }, (_, index) => (
            <View key={index} style={[styles.progressDot, index <= step && styles.progressDotActive]} />
          ))}
        </View>
        <Text style={styles.eyebrow}>初期設定を行います · {step + 1} / {setupStepCount}</Text>
        <Text style={styles.title}>
          {step === 0
            ? '今日を整えて、\n明日を軽やかに。'
            : step === 1
              ? '休日を教えてください。'
              : step === 2
                ? '家事を選んでください。'
                : step === 3
                  ? '前回の実施時期を設定'
                  : step === 4 ? '天気に使う地域を設定' : 'ゴミ収集日を設定'}
        </Text>

        {step === 0 ? (
          <>
            <Text style={styles.body}>いつもの家事頻度を教えてください。あとからいつでも変更できます。</Text>
            <AppButton title="共有グループを使う" variant="quiet" onPress={() => router.push('/sharing')} />
            <View style={styles.modeList}>
              {modeOptions.map((option) => (
                <Pressable
                  key={option.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: mode === option.id }}
                  onPress={() => setMode(option.id)}
                  style={[styles.modeOption, mode === option.id && styles.modeSelected]}>
                  <View style={[styles.checkbox, mode === option.id && styles.checkboxSelected]}>{mode === option.id ? <Text style={styles.check}>✓</Text> : null}</View>
                  <Text style={[styles.modeTitle, mode === option.id && styles.selectedText]}>{option.title}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <Text style={styles.body}>家事を行いやすい曜日を選んでください。複数選択できます。</Text>
            <View style={styles.weekdayList}>
              {weekdayOptions.map((day) => {
                const selected = restDays.includes(day.id);
                return (
                  <Pressable key={day.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => toggleRestDay(day.id)} style={[styles.weekdayOption, selected && styles.weekdaySelected]}>
                    <View style={[styles.checkbox, selected && styles.checkboxSelected]}>{selected ? <Text style={styles.check}>✓</Text> : null}</View>
                    <Text style={styles.weekdayName}>{day.label}曜日</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.hint}>休日を選ばない場合、休日を優先した日程調整は行いません。</Text>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <Text style={styles.body}>定期的に行う家事を選びます。あとから設定で変更できます。</Text>
            <View style={styles.choreList}>
              {availableChores.map((chore) => (
                <SetupChoreRow key={chore.id} chore={chore} selected={enabledChoreIds.has(chore.id)} onPress={() => toggleChore(chore.id)} />
              ))}
            </View>
            <AppButton
              title={enabledChoreIds.size === availableChores.length ? '選択をすべて外す' : 'すべて選択'}
              onPress={() => setEnabledChoreIds(enabledChoreIds.size === availableChores.length ? new Set() : new Set(availableChores.map((chore) => chore.id)))}
              variant="quiet"
              compact
            />
          </>
        ) : null}

        {step === 3 ? (
          <>
            <Text style={styles.body}>前回行った時期が分かる家事だけ選んでください。「分からない」も使えます。</Text>
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

        {step === 4 ? (
          <>
            <Text style={styles.body}>天気予報に使う市区町村を入力してください。候補から選んだ地域だけを保存します。設定しない場合は空欄のまま始められます。</Text>
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
              {weatherSuggestions.status === 'searching' ? <ActivityIndicator color={palette.accent} /> : null}
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
            {weatherSuggestions.status === 'error'
              ? <Text style={styles.error}>{weatherSuggestions.error}</Text>
              : null}
            {weatherSuggestions.status === 'debouncing' || weatherSuggestions.status === 'searching'
              ? <Text style={styles.hint}>市区町村を検索しています…</Text>
              : null}
            {weatherLocation ? <Text style={styles.selectedRegion}>天気に使う地域：{weatherLocation.displayName}</Text> : null}
            <WeatherAttribution />
            <LocationAttribution />
            {weatherMessage ? <Text style={weatherMessage.kind === 'success' ? styles.success : styles.error}>{weatherMessage.text}</Text> : null}
            <Text style={styles.hint}>入力すると候補を検索します。候補は「市区町村、都道府県」で表示します。天気連動は候補を確定した場合だけ動作します。</Text>
          </>
        ) : null}

        {step === 5 ? (
          <>
            <Text style={styles.body}>ゴミの種類と収集周期を登録できます。設定せずに始めて、あとから追加することもできます。</Text>
            <WasteScheduleEditor key={editingWaste?.id ?? 'new'} initial={editingWaste} disabled={saving}
              onCancel={editingWaste ? () => setEditingWaste(undefined) : undefined}
              onSubmit={async (schedule) => {
                const draft = { ...schedule, id: schedule.id ?? `setup-waste-${Date.now()}-${wasteSequence.current++}` };
                setWasteSchedules((current) => current.some((item) => item.id === draft.id)
                  ? current.map((item) => item.id === draft.id ? draft : item) : [...current, draft]);
                setEditingWaste(undefined);
              }} />
            <SectionHeading title="登録済み" trailing={<Text style={styles.hint}>{wasteSchedules.length}種類</Text>} />
            {!wasteSchedules.length ? <Text style={styles.hint}>収集日はまだ登録されていません。</Text> : wasteSchedules.map((schedule) => (
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
            <SectionHeading title="次の収集日" />
            {wasteSchedules.flatMap((schedule) => generateWasteCollectionDates({ ...schedule, id: schedule.id!, householdId: snapshot.household.id }, localDateFromDate(new Date()), addDays(localDateFromDate(new Date()), 35)))
              .sort((left, right) => left.date.localeCompare(right.date)).slice(0, 4)
              .map((occurrence) => <Text key={`${occurrence.scheduleId}-${occurrence.date}`} style={[styles.hint, { color: wasteTypeColor(occurrence.label) }]}>{formatJapaneseDate(occurrence.date, { weekday: true })}　{occurrence.label}</Text>)}
          </>
        ) : null}

        <Text style={styles.disclaimer}>周期の初期値は調整用のたたき台です。家事ごとに変更できます。</Text>
      </ScrollView>

      <View style={styles.footer}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {step < setupStepCount - 1 ? (
          <>
            <AppButton title="次へ" onPress={() => setStep((current) => current + 1)} disabled={saving} />
            {step === 3 ? <AppButton title="前回の時期はスキップ" onPress={() => { setPreviousChoices({}); setStep(4); }} variant="secondary" disabled={saving} /> : null}
          </>
        ) : (
          <>
            <AppButton title={saving ? '設定中…' : '設定して始める'} onPress={() => void saveSetup(false)} disabled={saving} />
            <AppButton title="ゴミ収集日はスキップして始める" onPress={() => void saveSetup(true)} variant="secondary" disabled={saving} />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function SetupChoreRow({ chore, selected, onPress }: { chore: ChoreDefinition; selected: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={onPress} style={styles.choreRow}>
      <View style={styles.choreCopy}>
        <Text style={styles.choreName}>{chore.name}</Text>
        <Text style={styles.choreCategory}>{chore.category} · {chore.estimatedMinutes ? `約${chore.estimatedMinutes}分` : '時間目安なし'}</Text>
      </View>
      <View style={[styles.checkbox, selected && styles.checkboxSelected]}>{selected ? <Text style={styles.check}>✓</Text> : null}</View>
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
  modeList: { gap: 9, marginTop: 3 },
  modeOption: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: palette.accent, borderRadius: 15, backgroundColor: palette.surface, paddingHorizontal: 13, paddingVertical: 11 },
  modeSelected: { backgroundColor: palette.accentSoft },
  modeTitle: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  selectedText: { color: palette.accent },
  weekdayList: { gap: 9, marginTop: 1 },
  weekdayOption: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 13, borderRadius: 15, borderWidth: 1, borderColor: palette.accent, backgroundColor: palette.surface, paddingHorizontal: 15 },
  weekdaySelected: { backgroundColor: palette.accentSoft },
  weekdayName: { ...typography.label, color: palette.ink, fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  hint: { ...typography.caption, color: palette.muted },
  choreList: { gap: 7 },
  choreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, paddingVertical: 9 },
  choreCopy: { flex: 1, gap: 3, paddingRight: 10 },
  choreName: { ...typography.subheading, color: palette.ink, fontWeight: '600' },
  choreCategory: { ...typography.caption, color: palette.muted },
  checkbox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: palette.accent, alignItems: 'center', justifyContent: 'center' },
  checkboxSelected: { backgroundColor: palette.accent, borderColor: palette.accent },
  check: { color: palette.accentInk, fontSize: 15, fontWeight: '800' },
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
  disclaimer: { ...typography.caption, color: palette.muted, textAlign: 'center' },
  footer: { alignItems: 'stretch', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 8 },
});
