import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton, BackButton, Card, palette, ScreenHeading, SectionHeading, typography } from '../../../components/planner-ui';
import type { Appliance } from '../../appliance-care/contracts';
import type { UploadedManualInput, ApplianceCareApiRequest, ProductVerifiedResponse } from '../../appliance-care/api-contracts';
import { ManualUploadInput } from '../../appliance-care/manual-upload-input';
import { ApplianceAiAccount } from '../../appliance-care/ai-account';
import { analyzeApplianceCareRequest } from '../../appliance-care/api-client';
import { MaintenanceTaskCard, OfficialLink } from '../../appliance-care/appliance-detail-content';
import { useAbortApplianceRequestOnLeave } from '../../appliance-care/use-abort-on-leave';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2ApplianceReview, V2ApplianceReviewResult } from '../v2/appliance-actions';
import type { V2MutationOutcome } from './mutation-outcome';
import { V2TextField } from './form-controls';

export type V2ApplianceMode = 'appliance' | 'applianceReview';
const responseFor = (appliance: Appliance): ProductVerifiedResponse => ({ status: 'verified', product: { manufacturer: appliance.manufacturer,
  productName: appliance.productName, modelNumber: appliance.modelNumber, ...(appliance.category ? { category: appliance.category } : {}) },
officialSources: { manualUrl: appliance.officialManualUrl, ...(appliance.officialProductUrl ? { productUrl: appliance.officialProductUrl } : {}) }, analysis: appliance.analysis });
const page = { padding: 16, paddingBottom: 40, gap: 14 };
const body = { ...typography.body, color: palette.ink };
const caption = { ...typography.caption, color: palette.muted };
const warning = { ...typography.caption, color: palette.warning };

/** Review is explicit. No API completion, navigation or refresh can silently replace shared chores. */
export function V2ApplianceScreen({ model, mode, applianceId, actions, busy, perform, onBack, onOpen, onReview, onConfiguration, onDetails, header, initialProductName }: {
  model: V2GroupScreenModel; mode: V2ApplianceMode; applianceId?: string; actions: V2GroupController['actions']; busy: boolean;
  perform: (work: () => Promise<unknown>) => Promise<V2MutationOutcome>; onBack: () => void; onOpen?: (id: string) => void;
  initialProductName?: string; onReview?: (id?: string) => void; onConfiguration: (id: string) => void; onDetails?: (id: string) => void; header?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const pageStyle = { ...page, paddingBottom: Math.max(page.paddingBottom, insets.bottom + 24) };
  const loadedDetail = model.appliances?.detail;
  const detail = loadedDetail?.row.id === applianceId ? loadedDetail : undefined;
  // Retain the displayed basis throughout an API request and review. A remote refresh cannot bless an old draft.
  const [basis] = useState(() => detail); const starting = basis?.appliance;
  const [input, setInput] = useState<ApplianceCareApiRequest>(() => ({ manufacturer: starting?.manufacturer ?? '', productName: starting?.productName ?? initialProductName ?? '', modelNumber: starting?.modelNumber ?? '', ...(starting?.category ? { category: starting.category } : {}) }));
  const [canAnalyze, setCanAnalyze] = useState(false);
  const [manual, setManual] = useState<UploadedManualInput>();
  const draft = useRef(input); const [response, setResponse] = useState<ProductVerifiedResponse | null>(null);
  const [chosen, setChosen] = useState<string[]>([]); const chosenRef = useRef(chosen);
  const [reviewed, setReviewed] = useState(false); const reviewedRef = useRef(false);
  const [candidateId, setCandidateId] = useState<string | null>(null); const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null); const [pendingRead, setPendingRead] = useState(false);
  const [saved, setSaved] = useState<V2ApplianceReviewResult | null>(null); const [analyzing, setAnalyzing] = useState(false); const [stage, setStage] = useState('公式資料を確認しています');
  const working = useRef(false); const request = useRef<AbortController | null>(null);
  const beginRequest = useAbortApplianceRequestOnLeave(request);
  const locked = busy || pendingRead || analyzing;
  const check = (value: boolean) => { reviewedRef.current = value; setReviewed(value); };
  const change = (field: 'manufacturer' | 'productName' | 'modelNumber', value: string) => {
    if (working.current || locked || saved) return;
    draft.current = { ...draft.current, [field]: value }; setInput(draft.current); setResponse(null); check(false); setSaved(null);
  };
  const analyze = async (override?: ApplianceCareApiRequest) => {
    if (working.current || locked) return;
    if (!canAnalyze) { setError('ログインと正規端末の確認が済むまで家電AIは利用できません。'); return; }
    if (!manual) { setError('取扱説明書PDFを選び、送信の確認をしてください。'); return; }
    working.current = true; const controller = beginRequest(() => { working.current = false; setAnalyzing(false); });
    setAnalyzing(true); setResponse(null); check(false); setError(null); setSaved(null);
    try {
      const result = await analyzeApplianceCareRequest({ ...(override ?? draft.current), manual, ...(applianceId ? { forceReanalysis: true } : {}) }, undefined, undefined,
        value => { if (request.current === controller && !controller.signal.aborted) setStage(value === 'product_verification' ? 'PDFを確認しています' : '説明書PDFを解析しています'); }, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      if (result.status === 'verified') { setResponse(result); chosenRef.current = []; setChosen([]); }
      else setError(result.status === 'ambiguous' ? '製品を特定できませんでした。製品名・型番を詳しく入力し直してください。' : result.message);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '解析結果を取得できませんでした。'); }
    finally { if (request.current === controller) { request.current = null; working.current = false; setAnalyzing(false); } }
  };
  const execute = async (work: () => Promise<unknown>) => {
    if (working.current || locked) return; working.current = true; setError(null);
    try {
      const outcome = await perform(work);
      if (!outcome.committed) throw outcome.error instanceof Error ? outcome.error : new Error('家電の変更を保存できませんでした。');
      setPendingRead(!outcome.refreshed); setDeleting(false); setCandidateId(null); setResponse(null); check(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '家電の変更を保存できませんでした。'); }
    finally { working.current = false; }
  };
  const save = (review: V2ApplianceReview) => execute(async () => {
    if (!reviewedRef.current) throw new Error('メーカー・型番・手順・注意事項を確認してください。');
    const result = await actions.reviewAppliance(review); setSaved(result);
  });
  const executeRead = async () => {
    if (working.current || busy) return; working.current = true;
    try { const result = await perform(async () => {}); setPendingRead(!result.refreshed); }
    finally { working.current = false; }
  };
  const pending = pendingRead ? <Card><Text style={body}>端末に保存済みです。再送せず、現在の家電を読み直してください。</Text>
    <AppButton title="保存済みの家電を再読込" disabled={busy} onPress={() => void executeRead()} /></Card> : null;
  const intro = <View style={{ gap: 14 }}>{header}<BackButton disabled={busy} onPress={() => { request.current?.abort(); onBack(); }} />
    <ScreenHeading title={mode === 'applianceReview' ? '家電の解析・共有' : '共有家電のお手入れ'} />
    {error ? <Text accessibilityRole="alert" style={warning}>{error}</Text> : null}{pending}
    {saved ? <Card><Text style={body}>家電の確認内容を端末に保存しました。新しい家事{saved.createdChoreIds.length}件は無効で追加しています。既存の家事は保持しています。</Text>
      <Text style={caption}>他メンバーへの反映は同期後です。周期・負荷・有効状態は管理者が設定します。</Text>
      {onOpen ? <AppButton title="保存した共有家電を開く" disabled={locked} onPress={() => onOpen(saved.applianceId)} /> : null}
      {saved.createdChoreIds.map(id => <AppButton key={id} title={`「${model.plan.chores.find(chore => chore.id === id)?.name ?? '追加した家事'}」の共通設定`} disabled={locked} variant="quiet" onPress={() => onConfiguration(id)} />)}</Card> : null}
  </View>;
  const currentCandidate = detail?.candidates.find(candidate => candidate.operationId === candidateId);
  const appliance = mode === 'applianceReview' ? null : detail?.appliance ?? currentCandidate?.appliance;
  const analysis = mode === 'applianceReview' ? response?.analysis : appliance?.analysis;
  const product = mode === 'applianceReview' ? response?.product : appliance;
  const productUrl = response?.officialSources.productUrl ?? appliance?.officialProductUrl;
  const instructionsDiffer = (name: string, steps: string[]) => model.plan.chores.some(chore => chore.applianceId === applianceId && chore.applianceTaskName === name
    && (chore.instructions.length !== steps.length || chore.instructions.some((step, index) => step !== steps[index])));
  const reviewToggle = <Pressable accessibilityRole="checkbox" accessibilityLabel="メーカー・型番・手順・注意事項を確認した" accessibilityState={{ checked: reviewed, disabled: locked }} disabled={locked}
    onPress={() => check(!reviewedRef.current)} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <View style={{ width: 24, height: 24, borderRadius: 5, borderWidth: 2, borderColor: palette.accent, backgroundColor: reviewed ? palette.accent : 'transparent' }} />
    <Text style={[body, { flex: 1 }]}>メーカー・型番・手順・注意事項を確認した</Text></Pressable>;
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}><FlatList
    contentContainerStyle={pageStyle} data={analysis?.tasks ?? []} keyExtractor={(task, index) => `${index}:${task.name}`} initialNumToRender={1} maxToRenderPerBatch={1} windowSize={3} removeClippedSubviews={false}
    keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" extraData={{ chosen, reviewed, locked }}
    ListHeaderComponent={<View style={{ gap: 14 }}>{intro}
      {mode === 'applianceReview' ? <>
        <Text style={caption}>解析を実行すると、メーカー・製品名・型番と、選択した説明書PDFを解析APIとAI提供元へ送信します。PDF原本は共有しません。結果は確認して保存するまで、他のメンバーへ共有されません。既存家事の周期・有効状態・手順は上書きしません。</Text>
        {basis?.source.kind === 'conflict' ? <Text style={warning}>確認して共有すると、表示開始時にあった解析の競合を新しい内容で解決します。元の履歴は保持します。</Text> : null}
        {basis?.row.deleted || basis?.alive.kind === 'conflict' ? <Text style={warning}>確認して共有すると、この家電をグループ全員の一覧へ復元します。既存家事の削除状態は変更しません。</Text> : null}
        {applianceId && !detail ? <Text style={warning}>対象の共有家電を読み込めません。家電一覧から開き直してください。</Text> : null}
        <V2TextField label="メーカー" value={input.manufacturer} onChangeText={value => change('manufacturer', value)} editable={!locked && !saved && !starting} maxLength={120} />
        <V2TextField label="製品名" value={input.productName} onChangeText={value => change('productName', value)} editable={!locked && !saved} maxLength={120} />
        <V2TextField label="型番" value={input.modelNumber} onChangeText={value => change('modelNumber', value)} editable={!locked && !saved && !starting} maxLength={120} />
        <Text style={caption}>月5回まで（再解析を含む）。毎月1日9時（日本時間）に更新。受付後の中止・結果検証の失敗は1回に数えます。OpenAIから結果を得られないとサーバーで確認した障害は消費しません。端末とアカウントの少ない残回数を適用します。</Text>
        <ApplianceAiAccount disabled={locked} onReady={setCanAnalyze} />
        <ManualUploadInput disabled={locked || Boolean(saved)} onChange={setManual} />
        <AppButton title="選択したPDFを解析する" disabled={!canAnalyze || !manual || locked || Boolean(saved) || Boolean(applianceId && !detail)} onPress={() => void analyze()} />
        {analyzing ? <><ActivityIndicator color={palette.accent} /><Text style={caption}>{stage}</Text><AppButton title="解析を中止" variant="quiet" onPress={() => request.current?.abort()} /></> : null}
      </> : !detail ? <Text style={warning}>対象の共有家電を表示できません。一覧から開き直してください。</Text> : <>
        {detail.row.needsReview ? <Card><Text style={warning}>{detail.row.deleted ? 'この家電は削除されています。' : detail.alive.kind === 'conflict' ? '削除と編集が重なっています。' : '解析内容の確認が必要です。'}署名付きの履歴は保持しています。</Text>
          {detail.candidates.map((candidate, index) => <AppButton key={candidate.operationId} title={`家電の候補${index + 1}を確認`} variant="quiet" disabled={locked}
            onPress={() => { setCandidateId(candidate.operationId); check(false); setDeleting(false); }} />)}
          {currentCandidate ? <Text style={caption}>候補の作成者：{currentCandidate.authorUserId} · {currentCandidate.recordedAt ?? '受付前'}{!currentCandidate.appliance ? '\nこの候補は再解析が必要です。' : ''}</Text> : null}
        </Card> : null}
        {onReview ? <AppButton title="この共有家電を再解析" variant="secondary" disabled={locked} onPress={() => onReview(applianceId)} /> : null}
        <AppButton title="この共有家電を削除" variant="quiet" disabled={locked} onPress={() => setDeleting(true)} />
        {detail.chores.length ? <Card><SectionHeading title="登録した共有家事" />{detail.chores.map(chore => <AppButton key={chore.id} title={`「${chore.name}」の手順・設定`} variant="quiet" disabled={locked} onPress={() => (onDetails ?? onConfiguration)(chore.id)} />)}</Card> : null}
        {deleting ? <Card><Text style={body}>グループ全員の家電一覧から削除します。登録済みの家事・周期・完了履歴は保持します。</Text>
          <AppButton title="共有家電の削除を確定" disabled={locked} onPress={() => void execute(() => actions.deleteAppliance(detail.row.selection))} />
          <AppButton title="削除をやめる" disabled={locked} variant="quiet" onPress={() => setDeleting(false)} /></Card> : null}
      </>}
      {product && analysis ? <Card><Text style={typography.subheading}>{product.productName}（{product.modelNumber}）</Text><Text style={caption}>{product.manufacturer} · 最終解析：{analysis.analyzedAt}</Text>
        <OfficialLink manufacturer={product.manufacturer} title="公式取扱説明書を見る ↗" url={response?.officialSources.manualUrl ?? appliance!.officialManualUrl} />
        {productUrl ? <OfficialLink manufacturer={product.manufacturer} title="公式製品情報を見る ↗" url={productUrl} /> : null}
        <Text style={caption}>メーカーの周期は資料の参考値です。共有の周期・有効状態は家事の共通設定で確認してください。</Text></Card> : null}
    </View>}
    renderItem={({ item: task, index }) => <MaintenanceTaskCard task={task} manufacturer={product!.manufacturer} index={index} schedule={<View style={{ gap: 8 }}>
      <Text style={body}>{task.recommendedIntervalDays ? `メーカー推奨：${task.recommendedIntervalDays}日` : 'メーカー指定：具体的な周期なし'}</Text>
      {instructionsDiffer(task.name, task.steps) ? <Text style={warning}>この解析と、登録済み家事の手順には違いがあります。登録済みの手順は保持しています。「登録した共有家事」から確認してください。</Text> : null}
      {mode === 'applianceReview' ? <Pressable accessibilityRole="checkbox" accessibilityLabel={`「${task.name}」を無効の共有家事として追加`} accessibilityState={{ checked: chosen.includes(task.name), disabled: locked }} disabled={locked}
        onPress={() => { chosenRef.current = chosenRef.current.includes(task.name) ? chosenRef.current.filter(name => name !== task.name) : [...chosenRef.current, task.name]; setChosen(chosenRef.current); }}
        style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 24, height: 24, borderRadius: 5, borderWidth: 2, borderColor: palette.accent, backgroundColor: chosen.includes(task.name) ? palette.accent : 'transparent' }} />
        <Text style={[body, { flex: 1 }]}>無効の共有家事として追加</Text></Pressable>
        : <Text style={caption}>登録した家事の設定・手順は共有家事の一覧から確認してください。</Text>}
    </View>} />}
    ListFooterComponent={analysis ? <View style={{ gap: 14 }}>
      {mode === 'applianceReview' && response && !saved ? <>{reviewToggle}<AppButton title="確認した解析結果を共有する" disabled={locked || !reviewed}
        onPress={() => void save({ reviewed: true, result: response, addTaskNames: chosenRef.current, ...(basis ? { selection: basis.row.selection,
          ...(basis.source.kind === 'conflict' ? { resolveOperationIds: basis.candidates.map(candidate => candidate.operationId) } : {}),
          ...(basis.row.deleted || basis.alive.kind === 'conflict' ? { restorePresence: true } : {}) } : {}) })} /></> : null}
      {mode === 'appliance' && appliance && detail?.row.needsReview ? <>{reviewToggle}<AppButton title={detail.source.kind === 'conflict' ? 'この候補で競合を解決' : '確認した内容で家電を残す'} disabled={locked || !reviewed}
        onPress={() => void save({ reviewed: true, result: responseFor(appliance), addTaskNames: [], selection: detail.row.selection, reviewedDisplayName: appliance.displayName,
          ...(detail.source.kind === 'conflict' ? { resolveOperationIds: detail.candidates.map(candidate => candidate.operationId) } : {}),
          ...(detail.row.deleted || detail.alive.kind === 'conflict' ? { restorePresence: true } : {}) })} /></> : null}
    </View> : undefined} />
  </KeyboardAvoidingView>;
}
