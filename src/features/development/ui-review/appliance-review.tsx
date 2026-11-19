import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { NumberInputField } from '@/components/number-input-field';
import { AppButton, Card, NavigationHeader, palette, typography } from '@/components/planner-ui';
import { SettingsCheckbox } from '@/components/settings-checkbox';
import { SettingsAction, SettingsGroup } from '@/components/settings-controls';
import { SettingsHeader } from '@/components/settings-header';
import { MaintenanceTaskCard } from '@/features/appliance-care/appliance-detail-content';
import { ApplianceLibrary, type ApplianceLibraryItem } from '@/features/appliance-care/appliance-library';
import { ApplianceTaskBook } from '@/features/appliance-care/appliance-task-book';
import { applianceAnalysisDate } from '@/features/appliance-care/analysis-date';
import { automaticApplianceTasks, defaultApplianceCycles } from '@/features/appliance-care/auto-save-policy';
import type { ApplianceCareAnalysisDraft, ApplianceCareTaskDraft } from '@/features/appliance-care/contracts';
import { applianceDisplayName, appliancePrimaryName, applianceSecondaryLabel } from '@/features/appliance-care/display-name';
import { ManualUploadInput } from '@/features/appliance-care/manual-upload-input';
import { toApplianceCareChore } from '@/features/appliance-care/to-chore-definition';

type SampleAppliance = ApplianceLibraryItem & {
  productName: string;
  analysis: ApplianceCareAnalysisDraft;
  cycles?: Record<number, string>;
  sharedTasks?: string[];
};

function task(name: string, steps: string[], details: Partial<Omit<ApplianceCareTaskDraft, 'name' | 'steps'>> = {}): ApplianceCareTaskDraft {
  return { name, steps, tools: [], safetyCautions: [], evidence: [], ...details };
}

function sample(input: Omit<SampleAppliance, 'analysis'> & { tasks: ApplianceCareTaskDraft[] }): SampleAppliance {
  const { tasks, ...item } = input;
  return { ...item, analysis: { manufacturer: item.manufacturer, model: item.modelNumber, tasks,
    analyzedAt: '2026-11-01T03:00:00Z', requiresUserReview: true } };
}

const fan = sample({
  id: 'qa-fan', source: 'personal', manufacturer: '架空・灯凪工房', productName: 'そよみ卓上ファン',
  modelNumber: 'QA-FAN-07', category: 'fan', displayName: '書斎の卓上ファン', cycles: { 0: '7' },
  tasks: [task('前面ガードを拭く', ['電源を切り、羽根が止まったことを確認する。', 'ガードの外側を乾いた布で拭く。'], {
    recommendedIntervalDays: 14, tools: ['柔らかい布'], safetyCautions: ['ガードの中に指を入れない。'], estimatedMinutes: 3,
  })],
});

const purifier = sample({
  id: 'qa-purifier', source: 'shared', manufacturer: '架空・庭音製作所', productName: '庭音エアライブラリー 静かな読書室のためのワイドモデル',
  modelNumber: 'QA-AIR-LIBRARY-WIDE-LONG-1200', category: 'air_purifier', displayName: '共同ラウンジの窓際に置いている空気清浄機',
  tasks: [
    task('前面カバーと左右の吸気口の周囲にたまったほこりを確認する', [
      '運転を止め、前面と左右の吸気口が見える位置に立つ。', '左右を順に見て、吸気口の前に置いてある物を移す。',
      'カバーの外側にほこりが残っていたら、乾いた布でやさしく拭き取る。',
    ], { recommendedIntervalDays: 30, recommendedConditions: ['ほこりが目立つときは期間内でも確認する。'],
      tools: ['柔らかい布', '確認用のライト'], safetyCautions: ['吸気口の中に道具を差し込まない。'], estimatedMinutes: 5 }),
    task('表示窓の汚れを拭き取る', ['表示窓を乾いた布で軽く拭く。'], {
      recommendedConditions: ['表示が読みづらいとき', '指の跡が残ったとき'], tools: ['柔らかい布'],
    }),
    task('運転前に吹出口を確認する', ['吹出口に物が載っていないか見る。']),
    task('持ち手を拭く', ['左右の持ち手を乾いた布で拭く。'], { recommendedIntervalDays: 7 }),
    task('操作ボタンの周りを確認する', ['ボタンの周りに汚れがないか見る。']),
    task('設置面のほこりを取る', ['本体の周りの床を拭く。']),
    task('背面カバーの浮きを確認する', ['背面カバーを外側から見て浮きがないか確かめる。']),
    task('運転ランプの見え方を確かめる', ['ランプの前に物がないか見る。']),
    task('側面パネルを拭く', ['側面の平らな部分を柔らかい布で拭く。']),
    task('交換用フィルターの型番を照合する', ['本体に記載された型番と交換用品の表示を照合する。'], { recommendedConditions: ['交換前'] }),
    task('長期保管前に外側を拭く', ['本体の外側にほこりが残っていないか確かめる。']),
    task('保管袋のラベルを確認する', ['保管する本体と袋の型番を照らし合わせる。']),
  ],
});

const kettle = sample({
  id: 'qa-kettle', source: 'personal', manufacturer: '架空・灯凪工房', productName: 'しずくケトル',
  modelNumber: 'QA-KETTLE-0', category: 'electric_kettle', displayName: '台所の旧型ケトル', tasks: [],
});

const humidifier = sample({
  id: 'qa-humidifier', source: 'shared', manufacturer: '架空・庭音製作所', productName: 'かさね加湿器',
  modelNumber: 'QA-MIST-02', category: 'humidifier', displayName: '談話室の加湿器',
  tasks: [
    task('タンクの外側を拭く', ['タンクの外側に残った水滴を乾いた布で拭く。'], { recommendedIntervalDays: 7, tools: ['乾いた布'] }),
    task('水量表示を確認する', ['表示窓の目盛りが読み取れるか見る。'], { recommendedConditions: ['給水の前', '目盛りが見づらいとき'] }),
  ],
});

const mixed = [fan, purifier, kettle, { ...humidifier, needsReview: true }];
const dense = ['東棟の休憩室', '西棟の給湯室', '別館の受付', '図書室の窓際'].flatMap((room, i) =>
  mixed.map(item => ({ ...item, id: `${item.id}-room-${i}`, displayName: `${room}の${item.productName}` })));

export const applianceReviewScenarios = [
  { id: 'library', label: '家電一覧・個人とグループ' },
  { id: 'empty', label: '家電一覧・未登録' },
  { id: 'dense-library', label: '家電一覧・16台' },
  { id: 'partial', label: '家電一覧・個人分が未取得' },
  { id: 'single', label: 'お手入れ1項目・周期の変更あり' },
  { id: 'many', label: 'お手入れ12項目・長い製品名' },
  { id: 'no-care', label: 'お手入れ0項目・説明書なし' },
  { id: 'review', label: '共有するお手入れを選ぶ' },
  { id: 'personal-review', label: '個人のお手入れ周期を編集' },
  { id: 'manual-error', label: '説明書PDFを読み取れない' },
] as const;

type Panel = { view: 'library' } | { view: 'detail' | 'review'; appliance: SampleAppliance }
  | { view: 'manual'; appliance: SampleAppliance; failed?: boolean; reanalysis?: boolean };
const library: Panel = { view: 'library' };
function startingPanels(scenario: string): Panel[] {
  switch (scenario) {
    case 'single': return [library, { view: 'detail', appliance: fan }];
    case 'many': return [library, { view: 'detail', appliance: purifier }];
    case 'no-care': return [library, { view: 'detail', appliance: kettle }];
    case 'review': return [library, { view: 'review', appliance: humidifier }];
    case 'personal-review': return [library, { view: 'review', appliance: { ...humidifier, source: 'personal' } }];
    case 'manual-error': return [library, { view: 'manual', appliance: humidifier, failed: true }];
    default: return [library];
  }
}

export function ApplianceReview({ scenario }: { scenario: string }) {
  return <ApplianceSession key={scenario} scenario={scenario} />;
}

function ApplianceSession({ scenario }: { scenario: string }) {
  const [panels, setPanels] = useState(() => startingPanels(scenario));
  const [items, setItems] = useState<SampleAppliance[]>(() => {
    if (scenario === 'empty') return [];
    if (scenario === 'dense-library') return dense;
    if (scenario === 'partial') return mixed.filter(item => item.source === 'shared');
    if (scenario === 'personal-review') return [fan, kettle, { ...humidifier, source: 'personal' }];
    return mixed;
  });
  const panel = panels[panels.length - 1];
  const open = (next: Panel) => setPanels(current => [...current, next]);
  const back = () => setPanels(current => current.length > 1 ? current.slice(0, -1) : current);
  const remember = (item: SampleAppliance) => setItems(current => {
    const matches = (other: SampleAppliance) => other.id === item.id && other.source === item.source;
    return current.some(matches) ? current.map(other => matches(other) ? item : other) : [...current, item];
  });
  if (panel.view === 'library') return <ApplianceLibrary items={items} personalReady={scenario !== 'partial'}
    joined={scenario !== 'empty' && scenario !== 'personal-review'}
    onOpen={(source, id) => {
      const item = items.find(row => row.source === source && row.id === id);
      if (item) open({ view: item.needsReview ? 'review' : 'detail', appliance: item });
    }} onAdd={source => open({ view: 'manual',
      appliance: items.find(row => row.source === source && row.id === humidifier.id) ?? { ...humidifier, source } })} />;
  const appliance = panel.view === 'detail'
    ? items.find(row => row.source === panel.appliance.source && row.id === panel.appliance.id) ?? panel.appliance
    : panel.appliance;
  if (panel.view === 'manual') return <SampleManual appliance={appliance} failed={panel.failed} reanalysis={panel.reanalysis} onBack={back}
    onAnalyzed={() => {
      const result = appliance.analysis.tasks.length ? appliance : { ...appliance, analysis: { ...appliance.analysis,
        tasks: [task('水位窓を確認する', ['水位窓の目盛りが読めるか確かめる。'], { recommendedConditions: ['給水前'] })] } };
      if (result.source === 'personal') remember(result);
      setPanels(current => [...current.slice(0, -1), { view: 'review', appliance: result }]);
    }} />;
  return <SampleBook key={`${panel.view}:${appliance.source}:${appliance.id}`} appliance={appliance} reviewing={panel.view === 'review'} onBack={back}
    onReanalyze={() => open({ view: 'manual', appliance, reanalysis: true })}
    onSave={updated => { remember(updated); setPanels([library, { view: 'detail', appliance: updated }]); }} />;
}

const unreadableName = '見本_文字が読み取れない説明書.pdf';
function SampleManual({ appliance, failed = false, reanalysis = false, onBack, onAnalyzed }: {
  appliance: SampleAppliance; failed?: boolean; reanalysis?: boolean; onBack(): void; onAnalyzed(): void;
}) {
  const readableName = `見本_${appliance.modelNumber}_取扱説明書.pdf`;
  const [filename, setFilename] = useState<string | undefined>(failed ? unreadableName : undefined);
  const [choosing, setChoosing] = useState(false);
  const [invalid, setInvalid] = useState(failed);
  const analyze = () => {
    if (!filename) return;
    if (filename === unreadableName) setInvalid(true);
    else onAnalyzed();
  };
  return <View style={styles.root}>
    <NavigationHeader><SettingsHeader title={reanalysis ? 'PDFを再解析' : '家電を追加'} onBack={onBack} /></NavigationHeader>
    <ScrollView contentContainerStyle={styles.form}>
      <SettingsGroup title="取扱説明書">
        <ManualUploadInput filename={filename} onPickingChange={starting => {
          if (starting) setChoosing(value => !value);
          return false; // Intercept before the system file picker opens.
        }} onChange={() => undefined} />
        {choosing ? <SettingsGroup plain compact title="サンプルPDF">{[readableName, unreadableName].map(name =>
          <AppButton key={name} title={name} variant="surface" onPress={() => {
            setFilename(name); setChoosing(false); setInvalid(false);
          }} />)}</SettingsGroup> : null}
      </SettingsGroup>
      <SettingsAction intent="primary" placement="page" compact={false} title={reanalysis ? 'PDFを再解析' : 'PDFを解析'}
        disabled={!filename || choosing} onPress={analyze} />
      {invalid ? <Card><Text accessibilityRole="header" style={styles.title}>説明書PDFを確認してください</Text>
        <Text accessibilityRole="alert" style={styles.body}>文字を読み取れませんでした。別の取扱説明書PDFを選んでください。</Text></Card> : null}
    </ScrollView>
  </View>;
}

function SampleBook({ appliance, reviewing, onBack, onReanalyze, onSave }: {
  appliance: SampleAppliance; reviewing: boolean; onBack(): void; onReanalyze(): void; onSave(value: SampleAppliance): void;
}) {
  const { analysis } = appliance;
  const shared = appliance.source === 'shared';
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [cycles, setCycles] = useState(() => appliance.cycles ?? defaultApplianceCycles(analysis));
  const [error, setError] = useState<string>();
  const chores = useMemo(() => shared ? [] : automaticApplianceTasks(analysis, appliance.cycles ?? defaultApplianceCycles(analysis))
    .map((approved, index) => toApplianceCareChore(`${appliance.id}-task-${index}`, 'qa-appliance-household',
      { ...appliance, applianceId: appliance.id, manualUrl: '' }, analysis, approved)), [analysis, appliance, shared]);
  const name = appliancePrimaryName(appliance, appliance.displayName);
  const subtitle = applianceSecondaryLabel(name, [appliance.displayName, applianceDisplayName(appliance)]);
  const save = () => {
    if (shared) {
      if (confirmed) onSave({ ...appliance, needsReview: false, sharedTasks: [...new Set([...(appliance.sharedTasks ?? []), ...chosen])] });
    } else {
      try { automaticApplianceTasks(analysis, cycles); }
      catch (cause) { setError(cause instanceof Error ? cause.message : '周期を確認してください。'); return; }
      onSave({ ...appliance, cycles });
    }
  };
  return <ApplianceTaskBook embedded tasks={analysis.tasks} label={name}
    title={reviewing ? shared ? '家電を追加' : 'お手入れ項目・周期の変更' : 'お手入れ方法'} onBack={onBack} backAccessibilityLabel={reviewing ? '戻る' : '家電一覧へ戻る'}
    header={<View style={styles.block}><Text accessibilityRole="header" style={styles.title}>{name}</Text>
      {subtitle ? <Text style={styles.note}>{subtitle}</Text> : null}<Text style={styles.note}>お手入れ {analysis.tasks.length}項目</Text></View>}
    renderTask={(item, index) => <MaintenanceTaskCard task={item} chore={chores[index]} schedule={
      reviewing && shared ? <View style={styles.row}><Text style={styles.rowLabel}>無効の共有家事として追加</Text>
        <SettingsCheckbox value={chosen.includes(item.name)} accessibilityLabel={`「${item.name}」を無効の共有家事として追加`}
          onValueChange={value => setChosen(before => value ? [...before, item.name] : before.filter(name => name !== item.name))} /></View>
      : reviewing ? <View style={styles.row}><Text style={styles.rowLabel}>周期</Text>
        <NumberInputField value={cycles[index] ?? ''} placeholder="任意" accessibilityLabel={`${item.name}の周期`}
          onChangeText={value => { setCycles(before => ({ ...before, [index]: value })); setError(undefined); }} /></View>
      : shared ? null : undefined
    } />}
    footer={<View style={styles.block}>
      <Text style={styles.note}>最終解析：{applianceAnalysisDate(analysis.analyzedAt)}</Text>
      {reviewing && shared ? <View style={styles.row}><Text style={styles.rowLabel}>メーカー・型番・手順・注意事項を確認した</Text>
        <SettingsCheckbox value={confirmed} onValueChange={setConfirmed} accessibilityLabel="メーカー・型番・手順・注意事項を確認した" /></View> : null}
      {error ? <Text accessibilityRole="alert" style={styles.warning}>{error}</Text> : null}
      {reviewing ? <AppButton title={shared ? '確認した解析結果を共有する' : '周期の変更を保存'} disabled={shared && !confirmed} onPress={save} />
        : <AppButton variant="quiet" title={shared ? 'この共有家電を再解析' : 'この家電を再解析'} onPress={onReanalyze} />}
      {!reviewing && appliance.sharedTasks?.length ? <SettingsGroup title="登録した共有家事">
        {appliance.sharedTasks.map(name => <Text key={name} style={styles.body}>{name}</Text>)}</SettingsGroup> : null}
    </View>} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  form: { padding: 16, paddingBottom: 32, gap: 14 },
  block: { gap: 10 },
  title: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  note: { ...typography.caption, color: palette.muted },
  warning: { ...typography.caption, color: palette.warning },
  body: { ...typography.body, color: palette.ink },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowLabel: { ...typography.body, color: palette.ink, flex: 1 },
});
