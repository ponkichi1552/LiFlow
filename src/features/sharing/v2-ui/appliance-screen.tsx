import { useEffect, useRef, useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ReactNode } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton, Card, NavigationHeader, palette, SectionHeading, typography } from '../../../components/planner-ui';
import type { Appliance, ApplianceCareTaskDraft } from '../../appliance-care/contracts';
import { ApplianceTaskBook } from '../../appliance-care/appliance-task-book';
import type { UploadedManualInput, ApplianceCareApiRequest, ProductVerifiedResponse } from '../../appliance-care/api-contracts';
import { ManualAnalysisForm } from '../../appliance-care/manual-analysis-form';
import { SettingsHeader } from '../../../components/settings-header';
import { analyzeApplianceCareRequest } from '../../appliance-care/api-client';
import { MaintenanceTaskCard } from '../../appliance-care/appliance-detail-content';
import { applianceDisplayName, appliancePrimaryName, applianceSecondaryLabel } from '../../appliance-care/display-name';
import { applianceAnalysisDate } from '../../appliance-care/analysis-date';
import { useAbortApplianceRequestOnLeave } from '../../appliance-care/use-abort-on-leave';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2ApplianceReview, V2ApplianceReviewResult } from '../v2/appliance-actions';
import type { V2MutationOutcome } from './mutation-outcome';
import { readApplianceManual } from '../../../platform/storage/appliance-manuals';
import { SettingsCheckbox } from '../../../components/settings-checkbox';
import { ApplianceManualAction } from '../../appliance-care/appliance-manual-action';

export type V2ApplianceMode = 'appliance' | 'applianceReview';
const responseFor = (appliance: Appliance): ProductVerifiedResponse => ({ status: 'verified', product: { manufacturer: appliance.manufacturer,
  productName: appliance.productName, modelNumber: appliance.modelNumber, ...(appliance.category ? { category: appliance.category } : {}) },
officialSources: { manualUrl: appliance.officialManualUrl, ...(appliance.officialProductUrl ? { productUrl: appliance.officialProductUrl } : {}) }, analysis: appliance.analysis });
const page = { padding: 16, paddingBottom: 40, gap: 14 };
const body = { ...typography.body, color: palette.ink };
const caption = { ...typography.caption, color: palette.muted };
const warning = { ...typography.caption, color: palette.warning };
type ManualSelection = { input: UploadedManualInput; filename?: string };

/** Review is explicit. No API completion, navigation or refresh can silently replace shared chores. */
export function V2ApplianceScreen({ model, mode, applianceId, actions, busy, perform, onBack, onOpen, onReview, onConfiguration, onDetails, header, personalDatabase }: {
  model: V2GroupScreenModel; mode: V2ApplianceMode; applianceId?: string; actions: V2GroupController['actions']; busy: boolean;
  perform: (work: () => Promise<unknown>) => Promise<V2MutationOutcome>; onBack: () => void; onOpen?: (id: string) => void;
  onReview?: (id?: string) => void; onConfiguration: (id: string) => void; onDetails?: (id: string) => void; header?: ReactNode;
  personalDatabase?: SQLiteDatabase;
}) {
  const insets = useSafeAreaInsets();
  const pageStyle = { ...page, paddingBottom: Math.max(page.paddingBottom, insets.bottom + 24) };
  const loadedDetail = model.appliances?.detail;
  const detail = loadedDetail?.row.id === applianceId ? loadedDetail : undefined;
  // Retain the displayed basis throughout an API request and review. A remote refresh cannot bless an old draft.
  const [firstDetail] = useState(() => detail);
  const [analysisReview, setAnalysisReview] = useState<{ response: ProductVerifiedResponse; manual: ManualSelection; basis: typeof detail } | null>(null);
  const basis = analysisReview ? analysisReview.basis : firstDetail ?? detail;
  const starting = basis?.appliance;
  const response = analysisReview?.response;
  const [canAnalyze, setCanAnalyze] = useState(false);
  const [manual, setManual] = useState<ManualSelection>(); const manualRef = useRef<ManualSelection | undefined>(undefined);
  const [picking, setPicking] = useState(false); const pickingRef = useRef(false);
  const [retainedManual, setRetainedManual] = useState<UploadedManualInput>();
  const manualTouched = useRef(false);
  useEffect(() => {
    const digest = starting?.analysis.manualSource?.sha256;
    if (!digest || !personalDatabase || mode !== 'applianceReview') return;
    let current = true;
    void readApplianceManual(personalDatabase, digest).then(base64 => {
      if (base64 && current && !manualTouched.current) {
        const input: UploadedManualInput = { base64, rightsConfirmed: true };
        setRetainedManual(input); manualRef.current = { input }; setManual(manualRef.current);
      }
    }).catch(() => { /* A legacy or unreadable PDF can be selected again without changing its saved analysis. */ });
    return () => { current = false; };
  }, [starting, personalDatabase, mode]);
  const [chosen, setChosen] = useState<string[]>([]); const chosenRef = useRef(chosen);
  const [reviewed, setReviewed] = useState(false); const reviewedRef = useRef(false);
  const [candidateId, setCandidateId] = useState<string | null>(null); const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null); const [pendingRead, setPendingRead] = useState(false);
  const [saved, setSaved] = useState<V2ApplianceReviewResult | null>(null); const savedRef = useRef<V2ApplianceReviewResult | null>(null); const [analyzing, setAnalyzing] = useState(false);
  const working = useRef(false); const request = useRef<AbortController | null>(null);
  const beginRequest = useAbortApplianceRequestOnLeave(request);
  const locked = busy || pendingRead || analyzing;
  const check = (value: boolean) => { reviewedRef.current = value; setReviewed(value); };
  const analyze = async () => {
    if (working.current || locked || pickingRef.current || savedRef.current) return;
    if (model.manualStorageSupported === false) { setError('解析前に、グループ管理で互換更新を行ってください。'); return; }
    if (!canAnalyze) { setError('ログインと正規端末の確認が済むまで家電AIは利用できません。'); return; }
    if (applianceId && !basis) { setError('再解析する家電を表示できません。'); return; }
    const submittedManual = manualRef.current;
    if (!submittedManual) { setError('取扱説明書PDFを選んでください。'); return; }
    working.current = true; const controller = beginRequest(() => { working.current = false; setAnalyzing(false); });
    setAnalyzing(true); setAnalysisReview(null); check(false); setError(null); setSaved(null);
    try {
      const input: ApplianceCareApiRequest = { identifyFromManual: true, manual: submittedManual.input,
        ...(starting ? { manufacturer: starting.manufacturer, productName: starting.productName, modelNumber: starting.modelNumber,
          ...(starting.category ? { category: starting.category } : {}), forceReanalysis: true } : {}) };
      const { deviceAnalysisDeliveries } = await import('../../../platform/storage/analysis-deliveries');
      const result = await analyzeApplianceCareRequest(input, undefined, undefined, undefined, controller.signal,
        personalDatabase ? deviceAnalysisDeliveries(personalDatabase) : undefined);
      if (request.current !== controller || controller.signal.aborted) return;
      if (result.status === 'verified') { setAnalysisReview({ response: result, manual: submittedManual, basis }); chosenRef.current = []; setChosen([]); }
      else setError(result.status === 'ambiguous' ? '製品を特定できませんでした。別の取扱説明書PDFを選んでください。' : result.message);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '解析結果を取得できませんでした。'); }
    finally { if (request.current === controller) { request.current = null; working.current = false; setAnalyzing(false); } }
  };
  const execute = async (work: () => Promise<unknown>) => {
    if (working.current || locked || pickingRef.current) return; working.current = true; setError(null);
    try {
      const outcome = await perform(work);
      if (!outcome.committed) throw outcome.error instanceof Error ? outcome.error : new Error('家電の変更を保存できませんでした。');
      setPendingRead(!outcome.refreshed); setDeleting(false); setCandidateId(null); setAnalysisReview(null); check(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '家電の変更を保存できませんでした。'); }
    finally { working.current = false; }
  };
  const save = (review: V2ApplianceReview) => execute(async () => {
    if (!reviewedRef.current) throw new Error('メーカー・型番・手順・注意事項を確認してください。');
    const selectedManual = analysisReview?.manual.input;
    const result = await actions.reviewAppliance({ ...review, ...(review.result.analysis.manualSource && selectedManual ? { manual: selectedManual } : {}) }); savedRef.current = result; setSaved(result);
  });
  const executeRead = async () => {
    if (working.current || busy) return; working.current = true;
    try { const result = await perform(async () => {}); setPendingRead(!result.refreshed); }
    finally { working.current = false; }
  };
  const pending = pendingRead ? <Card><Text style={body}>端末に保存済みです。再送せず、現在の家電を読み直してください。</Text>
    <AppButton title="保存済みの家電を再読込" disabled={busy} onPress={() => void executeRead()} /></Card> : null;
  const intro = <View style={{ gap: 14 }}>{header}
    {error ? <Text accessibilityRole="alert" style={warning}>{error}</Text> : null}{pending}
    {saved ? <Card><Text style={body}>家電の確認内容を端末に保存しました。新しい家事{saved.createdChoreIds.length}件は無効で追加しています。既存の家事は保持しています。</Text>
      {saved.personalRetentionPending ? <Text accessibilityRole="alert" style={warning}>共有先には保存済みです。個人側への保存は次回同期時に再試行します。</Text> : null}
      <Text style={caption}>他メンバーへの反映は同期後です。周期・負荷・有効状態は管理者が設定します。</Text>
      {onOpen ? <AppButton title="保存した共有家電を開く" disabled={locked} onPress={() => onOpen(saved.applianceId)} /> : null}
      {saved.createdChoreIds.map(id => <AppButton key={id} title={`「${model.plan.chores.find(chore => chore.id === id)?.name ?? '追加した家事'}」の共通設定`} disabled={locked} variant="quiet" onPress={() => onConfiguration(id)} />)}</Card> : null}
  </View>;
  const currentCandidate = detail?.candidates.find(candidate => candidate.operationId === candidateId);
  const appliance = mode === 'applianceReview' ? null : detail?.appliance ?? currentCandidate?.appliance;
  const analysis = mode === 'applianceReview' ? response?.analysis : appliance?.analysis;
  const product = mode === 'applianceReview' ? response?.product : appliance;
  const productName = product ? applianceDisplayName(product, appliance?.displayName) : '';
  const primaryName = product ? appliancePrimaryName({ ...product, analysis }, productName) : 'お手入れ';
  const secondaryName = product ? applianceSecondaryLabel(primaryName, [productName, applianceDisplayName(product)]) : '';
  const instructionsDiffer = (name: string, steps: string[]) => model.plan.chores.some(chore => chore.applianceId === applianceId && chore.applianceTaskName === name
    && (chore.instructions.length !== steps.length || chore.instructions.some((step, index) => step !== steps[index])));
  const reviewToggle = <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <Text style={[body, { flex: 1 }]}>メーカー・型番・手順・注意事項を確認した</Text>
    <SettingsCheckbox value={reviewed} onValueChange={check} disabled={locked} accessibilityLabel="メーカー・型番・手順・注意事項を確認した" />
  </View>;
  const bookHeader = <View style={{ gap: 14 }}>{intro}
      {mode === 'appliance' && personalDatabase && appliance?.analysis.manualSource ? <ApplianceManualAction database={personalDatabase} digest={appliance.analysis.manualSource.sha256} label={primaryName}
        accessKey={`${model.viewerUserId}:${model.plan.groupId}:${appliance.id}`} disabled={locked} /> : null}
      {mode === 'applianceReview' ? <>
        {model.manualStorageSupported === false ? <Text accessibilityRole="alert" style={warning}>PDFを共有保存するには、管理者によるグループの互換更新が必要です。更新前は解析を実行しません。</Text> : null}
        {basis?.source.kind === 'conflict' ? <Text style={warning}>確認して共有すると、表示開始時にあった解析の競合を新しい内容で解決します。元の履歴は保持します。</Text> : null}
        {basis?.row.deleted || basis?.alive.kind === 'conflict' ? <Text style={warning}>確認して共有すると、この家電をグループ全員の一覧へ復元します。既存家事の削除状態は変更しません。</Text> : null}
        {applianceId && !detail ? <Text style={warning}>対象の共有家電を読み込めません。家電一覧から開き直してください。</Text> : null}
        {!saved ? <ManualAnalysisForm retained={retainedManual} filename={manual?.filename} shared reanalysis={Boolean(applianceId)} working={analyzing} picking={picking}
          canAnalyze={canAnalyze} onReady={setCanAnalyze} usage={response?.usage} onPickingChange={value => {
            if (value && (working.current || savedRef.current)) return false;
            pickingRef.current = value; setPicking(value);
          }}
          disabled={model.manualStorageSupported === false || !manual || locked || Boolean(applianceId && !basis)} inputDisabled={locked}
          onManual={(value, name) => {
            if (working.current || locked || saved) return;
            manualTouched.current = true; manualRef.current = value ? { input: value, filename: name } : undefined;
            setManual(manualRef.current); setAnalysisReview(null); check(false);
          }} onAnalyze={() => void analyze()} onCancel={() => request.current?.abort()} /> : null}
      </> : !detail ? <Text style={warning}>対象の共有家電を表示できません。一覧から開き直してください。</Text> : <>
        {detail.row.needsReview ? <Card><Text style={warning}>{detail.row.deleted ? 'この家電は削除されています。' : detail.alive.kind === 'conflict' ? '削除と編集が重なっています。' : '解析内容の確認が必要です。'}署名付きの履歴は保持しています。</Text>
          {detail.candidates.map((candidate, index) => <AppButton key={candidate.operationId} title={`家電の候補${index + 1}を確認`} variant="quiet" disabled={locked}
            onPress={() => { setCandidateId(candidate.operationId); check(false); setDeleting(false); }} />)}
          {currentCandidate ? <Text style={caption}>候補の作成者：{currentCandidate.authorUserId} · {currentCandidate.recordedAt ?? '受付前'}{!currentCandidate.appliance ? '\nこの候補は再解析が必要です。' : ''}</Text> : null}
          {!analysis && onReview ? <AppButton title="この共有家電を再解析" variant="secondary" disabled={locked} onPress={() => onReview(applianceId)} /> : null}
        </Card> : null}

      </>}
      {product && analysis ? <View style={{ gap: 6 }}><Text accessibilityRole="header" style={[typography.subheading, { color: palette.ink, fontWeight: '700' }]}>{primaryName}</Text>
        {secondaryName ? <Text style={caption}>{secondaryName}</Text> : null}
        <Text style={caption}>お手入れ {analysis.tasks.length}項目</Text></View> : null}
    </View>;
  const renderTask = (task: ApplianceCareTaskDraft) => <MaintenanceTaskCard task={task} schedule={<View style={{ gap: 8 }}>
      {instructionsDiffer(task.name, task.steps) ? <Text style={warning}>この解析と、登録済み家事の手順には違いがあります。登録済みの手順は保持しています。「登録した共有家事」から確認してください。</Text> : null}
      {mode === 'applianceReview' ? <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={[body, { flex: 1 }]}>無効の共有家事として追加</Text>
        <SettingsCheckbox accessibilityLabel={`「${task.name}」を無効の共有家事として追加`} value={chosen.includes(task.name)} disabled={locked}
          onValueChange={() => { chosenRef.current = chosenRef.current.includes(task.name) ? chosenRef.current.filter(name => name !== task.name) : [...chosenRef.current, task.name]; setChosen(chosenRef.current); }} /></View>
        : null}
    </View>} />;
  const bookFooter = analysis ? <View style={{ gap: 14 }}>
      <Text style={caption}>最終解析：{applianceAnalysisDate(analysis.analyzedAt)}</Text>
      {mode === 'appliance' && detail ? <>
        {onReview ? <AppButton title="この共有家電を再解析" variant="quiet" disabled={locked} onPress={() => onReview(applianceId)} /> : null}
        <AppButton title="この共有家電を削除" variant="quiet" disabled={locked} onPress={() => setDeleting(true)} />
        {detail.chores.length ? <Card><SectionHeading title="登録した共有家事" />{detail.chores.map(chore => <AppButton key={chore.id} title={`「${chore.name}」の手順・設定`} variant="quiet" disabled={locked} onPress={() => (onDetails ?? onConfiguration)(chore.id)} />)}</Card> : null}
        {deleting ? <Card><Text style={body}>グループ全員の家電一覧から削除します。登録済みの家事・周期・完了履歴は保持します。</Text>
          <AppButton title="共有家電の削除を確定" disabled={locked} onPress={() => void execute(() => actions.deleteAppliance(detail.row.selection))} />
          <AppButton title="削除をやめる" disabled={locked} variant="quiet" onPress={() => setDeleting(false)} /></Card> : null}
      </> : null}
      {mode === 'applianceReview' && analysisReview && !saved ? <><Text numberOfLines={1} style={caption}>{analysisReview.manual.filename ?? '保存した取扱説明書PDF'}</Text>
        {reviewToggle}<AppButton title="確認した解析結果を共有する" disabled={locked || !reviewed}
        onPress={() => void save({ reviewed: true, result: analysisReview.response, addTaskNames: chosenRef.current, ...(basis ? { selection: basis.row.selection,
          ...(basis.source.kind === 'conflict' ? { resolveOperationIds: basis.candidates.map(candidate => candidate.operationId) } : {}),
          ...(basis.row.deleted || basis.alive.kind === 'conflict' ? { restorePresence: true } : {}) } : {}) })} /></> : null}
      {mode === 'appliance' && appliance && detail?.row.needsReview ? <>{reviewToggle}<AppButton title={detail.source.kind === 'conflict' ? 'この候補で競合を解決' : '確認した内容で家電を残す'} disabled={locked || !reviewed}
        onPress={() => void save({ reviewed: true, result: responseFor(appliance), addTaskNames: [], selection: detail.row.selection, reviewedDisplayName: appliance.displayName,
          ...(detail.source.kind === 'conflict' ? { resolveOperationIds: detail.candidates.map(candidate => candidate.operationId) } : {}),
          ...(detail.row.deleted || detail.alive.kind === 'conflict' ? { restorePresence: true } : {}) })} /></> : null}
    </View> : undefined;
  const title = mode === 'applianceReview' ? applianceId ? 'PDFを再解析' : '家電を追加' : 'お手入れ方法';
  const leave = () => { request.current?.abort(); onBack(); };
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
    {analysis ? <ApplianceTaskBook tasks={analysis.tasks} label={primaryName}
      title={title} embedded header={bookHeader} footer={bookFooter} renderTask={renderTask} onBack={leave} backDisabled={busy} bottomPadding={pageStyle.paddingBottom} />
      : <><NavigationHeader><SettingsHeader title={title} backDisabled={busy} onBack={leave} /></NavigationHeader><FlatList
        contentContainerStyle={pageStyle} data={[]} renderItem={() => null} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        ListHeaderComponent={bookHeader} /></>}
  </KeyboardAvoidingView>;
}
