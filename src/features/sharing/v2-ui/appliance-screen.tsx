import { useRef, useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ReactNode } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton, Card, NavigationHeader, palette, SectionHeading, typography } from '../../../components/planner-ui';
import type { Appliance, ApplianceCareTaskDraft } from '../../appliance-care/contracts';
import { ApplianceTaskBook } from '../../appliance-care/appliance-task-book';
import type { UploadedManualInput, ProductVerifiedResponse } from '../../appliance-care/api-contracts';
import { ManualAnalysisForm } from '../../appliance-care/manual-analysis-form';
import { SettingsHeader } from '../../../components/settings-header';
import { useTargetAnalysisWork } from '../../appliance-care/use-analysis-work';
import { useAnalysisListOnTabReturn } from '../../appliance-care/use-analysis-list-on-tab-return';
import { MaintenanceTaskCard } from '../../appliance-care/appliance-detail-content';
import { applianceDisplayName, appliancePrimaryName, applianceSecondaryLabel } from '../../appliance-care/display-name';
import { manualModelPageLabel } from '../../appliance-care/manual-model-pages';
import { deviceAnalysisWork } from '../../../platform/storage/analysis-work';
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
export function V2ApplianceScreen({ model, mode, applianceId, workId, returnsToLibrary = false, actions, busy, perform, onBack, onOpen, onReview, onConfiguration, onDetails, header, personalDatabase }: {
  model: V2GroupScreenModel; mode: V2ApplianceMode; applianceId?: string; workId?: string; returnsToLibrary?: boolean; actions: V2GroupController['actions']; busy: boolean;
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
  const [selectedWorkId, setSelectedWorkId] = useState(workId);
  const { value: analysisWork, failed: workReadFailed, retry: retryWorkRead } = useTargetAnalysisWork(mode === 'applianceReview' ? personalDatabase : undefined, model.viewerUserId, model.plan.groupId, applianceId, selectedWorkId);
  const trackSubmission = useAnalysisListOnTabReturn(analysisWork, returnsToLibrary && mode === 'applianceReview');
  const [ignoredWork, setIgnoredWork] = useState<string>();
  const currentWork = analysisWork?.id !== ignoredWork ? analysisWork : null;
  const basis = firstDetail ?? detail;
  const starting = basis?.appliance;
  const response = currentWork?.result?.status === 'verified' ? currentWork.result : null;
  const failure = currentWork?.result && currentWork.result.status !== 'verified' ? currentWork.result : null;
  const [canAnalyze, setCanAnalyze] = useState(false);
  const invalidManual = failure?.status === 'error' && failure.code === 'INVALID_MANUAL';
  const [manual, setManual] = useState<ManualSelection>(); const manualRef = useRef<ManualSelection | undefined>(undefined);
  const [picking, setPicking] = useState(false); const pickingRef = useRef(false);
  const retainedDigest = currentWork?.manualDigest ?? starting?.analysis.manualSource?.sha256;
  const [selection, setSelection] = useState<{ key: string; names: string[] }>();
  const selectionRef = useRef<typeof selection>(undefined);
  const [reviewedKey, setReviewedKey] = useState<string>(); const reviewedRef = useRef<string | undefined>(undefined);
  const [candidateId, setCandidateId] = useState<string | null>(null); const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null); const [pendingRead, setPendingRead] = useState(false);
  const [saved, setSaved] = useState<V2ApplianceReviewResult | null>(null); const savedRef = useRef<V2ApplianceReviewResult | null>(null);
  const [startingWork, setStartingWork] = useState(false);
  const working = useRef(false);
  const analyzing = startingWork || analysisWork?.state === 'pending';
  const locked = busy || pendingRead || analyzing;
  const reviewKey = mode === 'applianceReview' ? currentWork && response ? JSON.stringify([model.viewerUserId, model.plan.groupId, currentWork.id]) : undefined
    : detail ? JSON.stringify([model.viewerUserId, model.plan.groupId, detail.row.selection, candidateId ?? null]) : undefined;
  const reviewed = Boolean(reviewKey && reviewedKey === reviewKey);
  const chosen = selection?.key === reviewKey ? selection?.names ?? [] : [];
  const check = (value: boolean) => { reviewedRef.current = value ? reviewKey : undefined; setReviewedKey(reviewedRef.current); };
  const analyze = async () => {
    if (working.current || locked || pickingRef.current || savedRef.current || invalidManual) return;
    if (model.manualStorageSupported === false) { setError('解析前に、グループ管理で互換更新を行ってください。'); return; }
    if (!canAnalyze || !personalDatabase) { setError('ログインと正規端末の確認が済むまで家電AIは利用できません。'); return; }
    if (applianceId && !basis) { setError('再解析する家電を表示できません。'); return; }
    working.current = true;
    setStartingWork(true); check(false); setError(null); setSaved(null); selectionRef.current = undefined; setSelection(undefined);
    try {
      const id = await trackSubmission(async () => {
        const stored = !manualRef.current && retainedDigest ? await readApplianceManual(personalDatabase, retainedDigest) : null;
        const submitted = manualRef.current ?? (stored && { input: { base64: stored, rightsConfirmed: true as const }, filename: currentWork?.filename ?? starting?.displayName });
        if (!submitted) throw new Error('取扱説明書PDFを選んでください。');
        const { startAnalysisWork } = await import('../../../platform/appliance-care/analysis-work');
        return startAnalysisWork(personalDatabase, {
          owner: model.viewerUserId, target: { groupId: model.plan.groupId, applianceId }, filename: submitted.filename,
          request: { identifyFromManual: true, manual: submitted.input,
            ...(starting ? { manufacturer: starting.manufacturer, productName: starting.productName, modelNumber: starting.modelNumber,
              category: starting.category, forceReanalysis: true } : {}) },
          ...(basis ? { basis: { selection: basis.row.selection,
            ...(basis.source.kind === 'conflict' ? { resolveOperationIds: basis.candidates.map(candidate => candidate.operationId) } : {}),
            ...(basis.row.deleted || basis.alive.kind === 'conflict' ? { restorePresence: true } : {}) } } : {}),
        });
      });
      setSelectedWorkId(id);
      setIgnoredWork(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '解析を開始できませんでした。'); }
    finally { working.current = false; setStartingWork(false); }
  };
  const execute = async (work: () => Promise<unknown>) => {
    if (working.current || locked || pickingRef.current) return; working.current = true; setError(null);
    try {
      const outcome = await perform(work);
      if (!outcome.committed) throw outcome.error instanceof Error ? outcome.error : new Error('家電の変更を保存できませんでした。');
      setPendingRead(!outcome.refreshed); setDeleting(false); setCandidateId(null); check(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '家電の変更を保存できませんでした。'); }
    finally { working.current = false; }
  };
  const save = (review: V2ApplianceReview) => execute(async () => {
    if (!reviewKey || reviewedRef.current !== reviewKey) throw new Error(review.result.product.modelNumber === null
      ? '製品情報・手順・注意事項を確認してください。' : 'メーカー・型番・手順・注意事項を確認してください。');
    let selectedManual: UploadedManualInput | undefined;
    if (mode === 'applianceReview' && currentWork && review.result.analysis.manualSource) {
      if (!personalDatabase || applianceId && !currentWork.basis?.selection) throw new Error('解析時の家電を確認できませんでした。');
      const base64 = await readApplianceManual(personalDatabase, currentWork.manualDigest);
      if (!base64) throw new Error('解析したPDFを読み込めませんでした。');
      selectedManual = { base64, rightsConfirmed: true };
    }
    const result = await actions.reviewAppliance({ ...review, ...(selectedManual ? { manual: selectedManual } : {}) });
    savedRef.current = result; setSaved(result);
    if (currentWork && personalDatabase) await deviceAnalysisWork(personalDatabase).remove(model.viewerUserId, currentWork.id).catch(() => undefined);
  });
  const executeRead = async () => {
    if (working.current || busy) return; working.current = true;
    try { const result = await perform(async () => {}); setPendingRead(!result.refreshed); }
    finally { working.current = false; }
  };
  const pending = pendingRead ? <Card><Text style={body}>端末に保存済みです。再送せず、現在の家電を読み直してください。</Text>
    <AppButton title="保存済みの家電を再読込" disabled={busy} onPress={() => void executeRead()} /></Card> : null;
  const analysisError = failure && !invalidManual ? failure.status === 'ambiguous' ? '製品を特定できませんでした。別の取扱説明書PDFを選んでください。' : failure.message : null;
  const intro = <View style={{ gap: 14 }}>{header}
    {error || analysisError ? <Text accessibilityRole="alert" style={warning}>{error ?? analysisError}</Text> : null}{pending}
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
  const modelPage = response?.analysis.manualSource && manualModelPageLabel(response.product.modelNumber, response.product.modelPages);
  const instructionsDiffer = (name: string, steps: string[]) => model.plan.chores.some(chore => chore.applianceId === applianceId && chore.applianceTaskName === name
    && (chore.instructions.length !== steps.length || chore.instructions.some((step, index) => step !== steps[index])));
  const reviewLabel = product?.modelNumber === null ? '製品情報・手順・注意事項を確認した' : 'メーカー・型番・手順・注意事項を確認した';
  const reviewToggle = <SettingsCheckbox value={reviewed} onValueChange={check} disabled={locked} label={reviewLabel} />;
  const identity = product && analysis ? <View style={{ gap: 6 }}>
    <Text accessibilityRole="header" style={[typography.subheading, { color: palette.ink, fontWeight: '700' }]}>{primaryName}</Text>
    {secondaryName ? <Text style={caption}>{secondaryName}</Text> : null}
    {modelPage ? <Text style={caption}>{modelPage}</Text> : null}
    <Text style={caption}>{analysis.tasks.length ? `お手入れ ${analysis.tasks.length}項目` : 'お手入れ項目はありません。'}</Text>
    {mode === 'applianceReview' && !saved && analysis.tasks.length ? <Text style={caption}>選んだ項目は無効の共有家事として追加されます。</Text> : null}
  </View> : null;
  const bookHeader = <View style={{ gap: 14 }}>{intro}
      {mode === 'appliance' && personalDatabase && appliance?.analysis.manualSource ? <ApplianceManualAction database={personalDatabase} digest={appliance.analysis.manualSource.sha256} label={primaryName}
        accessKey={`${model.viewerUserId}:${model.plan.groupId}:${appliance.id}`} disabled={locked} /> : null}
      {mode === 'applianceReview' ? <>
        {model.manualStorageSupported === false ? <Text accessibilityRole="alert" style={warning}>PDFの共有には、管理者によるグループの更新が必要です。</Text> : null}
        {basis?.source.kind === 'conflict' ? <Text style={warning}>確認して共有すると、表示開始時にあった解析の競合を新しい内容で解決します。元の履歴は保持します。</Text> : null}
        {basis?.row.deleted || basis?.alive.kind === 'conflict' ? <Text style={warning}>確認して共有すると、この家電をグループ全員の一覧へ復元します。既存家事の削除状態は変更しません。</Text> : null}
        {applianceId && !detail ? <Text style={warning}>対象の共有家電を読み込めません。家電一覧から開き直してください。</Text> : null}
        {identity}
        {!saved ? <ManualAnalysisForm retained={Boolean(retainedDigest)} hasManual={Boolean(manual)} filename={analysisWork?.state === 'pending' ? analysisWork.filename : manual?.filename ?? currentWork?.filename}
          shared reanalysis={Boolean(applianceId)} reviewing={Boolean(response)} phase={currentWork?.state === 'pending' ? 'analyzing' : startingWork ? 'preparing' : undefined}
          picking={picking} invalidManual={invalidManual ? failure.message : undefined}
          canAnalyze={canAnalyze} onReady={setCanAnalyze} usage={response?.usage} onPickingChange={value => {
            if (value && (working.current || savedRef.current)) return false;
            pickingRef.current = value; setPicking(value);
          }}
          disabled={!personalDatabase || model.manualStorageSupported === false || Boolean(applianceId && !basis)} inputDisabled={locked}
          onManual={(value, name) => {
            if (working.current || locked || saved) return;
            manualRef.current = value ? { input: value, filename: name } : undefined;
            setManual(manualRef.current); setIgnoredWork(analysisWork?.id); setError(null); check(false);
          }} onAnalyze={() => void analyze()} /> : null}
      </> : !detail ? <Text style={warning}>対象の共有家電を表示できません。一覧から開き直してください。</Text> : <>
        {detail.row.needsReview ? <Card><Text style={warning}>{detail.row.deleted ? 'この家電は削除されています。' : detail.alive.kind === 'conflict' ? '削除と編集が重なっています。' : '解析内容の確認が必要です。'}署名付きの履歴は保持しています。</Text>
          {detail.candidates.map((candidate, index) => <AppButton key={candidate.operationId} title={`家電の候補${index + 1}を確認`} variant="quiet" disabled={locked}
            onPress={() => { setCandidateId(candidate.operationId); check(false); setDeleting(false); }} />)}
          {currentCandidate ? <Text style={caption}>候補の作成者：{currentCandidate.authorUserId} · {currentCandidate.recordedAt ?? '受付前'}{!currentCandidate.appliance ? '\nこの候補は再解析が必要です。' : ''}</Text> : null}
          {!analysis && onReview ? <AppButton title="この共有家電を再解析" variant="secondary" disabled={locked} onPress={() => onReview(applianceId)} /> : null}
        </Card> : null}

      </>}
      {mode === 'appliance' ? identity : null}
    </View>;
  const renderTask = (task: ApplianceCareTaskDraft) => <MaintenanceTaskCard task={task} schedule={<View style={{ gap: 8 }}>
      {instructionsDiffer(task.name, task.steps) ? <Text style={warning}>この解析と、登録済み家事の手順には違いがあります。登録済みの手順は保持しています。「登録した共有家事」から確認してください。</Text> : null}
      {mode === 'applianceReview' ? <SettingsCheckbox label="共有家事に追加" accessibilityLabel={`「${task.name}」を無効の共有家事として追加`} value={chosen.includes(task.name)} disabled={locked}
          onValueChange={() => {
            if (!reviewKey) return;
            const before = selectionRef.current?.key === reviewKey ? selectionRef.current.names : [];
            const names = before.includes(task.name) ? before.filter(name => name !== task.name) : [...before, task.name];
            selectionRef.current = { key: reviewKey, names }; setSelection(selectionRef.current);
          }} />
        : null}
    </View>} />;
  const bookFooter = analysis ? <View style={{ gap: 14 }}>
      {mode === 'appliance' && detail ? <>
        {onReview ? <AppButton title="この共有家電を再解析" variant="quiet" disabled={locked} onPress={() => onReview(applianceId)} /> : null}
        <AppButton title="この共有家電を削除" variant="quiet" disabled={locked} onPress={() => setDeleting(true)} />
        {detail.chores.length ? <Card><SectionHeading title="登録した共有家事" />{detail.chores.map(chore => <AppButton key={chore.id} title={`「${chore.name}」の手順・設定`} variant="quiet" disabled={locked} onPress={() => (onDetails ?? onConfiguration)(chore.id)} />)}</Card> : null}
        {deleting ? <Card><Text style={body}>グループ全員の家電一覧から削除します。登録済みの家事・周期・完了履歴は保持します。</Text>
          <AppButton title="共有家電の削除を確定" disabled={locked} onPress={() => void execute(() => actions.deleteAppliance(detail.row.selection))} />
          <AppButton title="削除をやめる" disabled={locked} variant="quiet" onPress={() => setDeleting(false)} /></Card> : null}
      </> : null}
      {mode === 'applianceReview' && response && !saved ? <><Text numberOfLines={1} style={caption}>{currentWork?.filename ?? '保存した取扱説明書PDF'}</Text>
        {reviewToggle}<AppButton title="確認した解析結果を共有する" disabled={locked || !reviewed}
        onPress={() => void save({ reviewed: true, result: response,
          addTaskNames: selectionRef.current?.key === reviewKey ? selectionRef.current?.names ?? [] : [], ...currentWork?.basis })} /></> : null}
      {mode === 'appliance' && appliance && detail?.row.needsReview ? <>{reviewToggle}<AppButton title={detail.source.kind === 'conflict' ? 'この候補で競合を解決' : '確認した内容で家電を残す'} disabled={locked || !reviewed}
        onPress={() => void save({ reviewed: true, result: responseFor(appliance), addTaskNames: [], selection: detail.row.selection, reviewedDisplayName: appliance.displayName,
          ...(detail.source.kind === 'conflict' ? { resolveOperationIds: detail.candidates.map(candidate => candidate.operationId) } : {}),
          ...(detail.row.deleted || detail.alive.kind === 'conflict' ? { restorePresence: true } : {}) })} /></> : null}
    </View> : undefined;
  const title = mode === 'applianceReview' ? response || saved ? '解析結果' : applianceId ? 'PDFを再解析' : '家電を追加' : 'お手入れ方法';
  const leave = onBack;
  const navigationHeader = <NavigationHeader><SettingsHeader title={title} backDisabled={busy} onBack={leave} /></NavigationHeader>;
  if (mode === 'applianceReview' && selectedWorkId && !analysisWork && !saved && !startingWork) return <>
    {navigationHeader}
    <View style={pageStyle}>
      <Text accessibilityRole={workReadFailed || !personalDatabase || analysisWork === null ? 'alert' : undefined} style={body}>
        {workReadFailed ? '保存した解析を読み込めませんでした。' : !personalDatabase || analysisWork === null ? 'この解析は見つかりませんでした。' : '保存した解析を読み込んでいます。'}
      </Text>
      {workReadFailed ? <AppButton title="再読み込み" onPress={retryWorkRead} /> : null}
    </View>
  </>;
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
    {analysis ? <ApplianceTaskBook tasks={analysis.tasks} label={primaryName}
      title={title} embedded header={bookHeader} footer={bookFooter} renderTask={renderTask} onBack={leave} backDisabled={busy} bottomPadding={pageStyle.paddingBottom} />
      : <>{navigationHeader}<FlatList
        contentContainerStyle={pageStyle} data={[]} renderItem={() => null} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        ListHeaderComponent={bookHeader} /></>}
  </KeyboardAvoidingView>;
}
