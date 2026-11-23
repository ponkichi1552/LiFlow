import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionLabel, AppButton, Card, Page, SectionHeading, palette, typography } from '@/components/planner-ui';
import { NumberInputField } from '@/components/number-input-field';
import type { UploadedManualInput, ApplianceCareApiResponse, ProductAnalysisErrorResponse, ProductVerifiedResponse } from '@/features/appliance-care/api-contracts';
import { ManualAnalysisForm } from '@/features/appliance-care/manual-analysis-form';
import { MaintenanceTaskCard } from '@/features/appliance-care/appliance-detail-content';
import { SettingsHeader } from '@/components/settings-header';
import { useTargetAnalysisWork } from '@/features/appliance-care/use-analysis-work';
import { useAnalysisListOnTabReturn } from '@/features/appliance-care/use-analysis-list-on-tab-return';
import { useWorkspace } from '@/hooks/use-workspace';
import type { ApplianceCareTaskDraft } from '@/features/appliance-care/contracts';
import { automaticApplianceTasks, defaultApplianceCycles } from '@/features/appliance-care/auto-save-policy';
import { applianceDisplayName, appliancePrimaryName } from '@/features/appliance-care/display-name';
import { manualModelPageLabel, manualModelPages } from '@/features/appliance-care/manual-model-pages';
import { usePlannerData } from '@/hooks/use-planner-data';
import { loadApplianceCareReviewContext, saveReviewedApplianceCare, saveReviewedApplianceCycles } from '@/platform/storage/repository';
import type { ApplianceCareReviewContext } from '@/platform/storage/repository';
import { applianceTaskCadenceKey, findApplianceTaskChore } from '@/features/appliance-care/persistence-policy';
import { readApplianceManual } from '@/platform/storage/appliance-manuals';
import { deviceAnalysisWork } from '@/platform/storage/analysis-work';

export default function ApplianceCareScreen() {
  const params = useLocalSearchParams<{ applianceId?: string; returnTo?: string; workId?: string }>();
  const applianceId = Array.isArray(params.applianceId) ? params.applianceId[0] : params.applianceId;
  const workId = Array.isArray(params.workId) ? params.workId[0] : params.workId;
  const returnToParam = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = returnToParam === '/chores' ? '/chores' : returnToParam === '/manual' ? '/manual' : undefined;
  return <PrivateApplianceEditor key={JSON.stringify([applianceId, workId])} applianceId={applianceId} workId={workId} returnTo={returnTo} />;
}

function PrivateApplianceEditor({ applianceId: initialApplianceId, workId, returnTo }: { applianceId?: string; workId?: string; returnTo?: '/chores' | '/manual' }) {
  const { database, refresh, readError } = usePlannerData({ personal: true });
  const { userId: owner } = useWorkspace();
  const [applianceId, setApplianceId] = useState(initialApplianceId);
  const [selectedWorkId, setSelectedWorkId] = useState(workId);
  const { value: analysis, focused, failed: workReadFailed, retry: retryWorkRead } = useTargetAnalysisWork(database, owner, undefined, applianceId, selectedWorkId);
  const trackSubmission = useAnalysisListOnTabReturn(analysis);
  const [canAnalyze, setCanAnalyze] = useState(false);
  const [manual, setManual] = useState<UploadedManualInput>();
  const [filename, setFilename] = useState<string>();
  const [picking, setPicking] = useState(false); const pickingRef = useRef(false);
  const manualRef = useRef<UploadedManualInput | undefined>(undefined);
  const [category, setCategory] = useState('');
  const [received, setReceived] = useState<{ owner: string; result: ApplianceCareApiResponse } | null>(null);
  const result = received?.owner === owner ? received?.result ?? null : null;
  const savedApplianceId = useRef<string | undefined>(applianceId);
  const [analysisSaved, setAnalysisSaved] = useState(false);
  const savingRef = useRef(false);
  const appliedWork = useRef<string | null>(null);
  const expectedAnalysisUpdate = useRef<string | null>(null);
  const [cycleValues, setCycleValues] = useState<Record<number, string>>({});
  const [working, setWorking] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [savedContext, setSavedContext] = useState<ApplianceCareReviewContext | null>(null);
  const [targetRead, setTargetRead] = useState<{ database: typeof database; found: boolean } | null>(null);
  const [targetRetry, setTargetRetry] = useState(0);
  const [displayError, setDisplayError] = useState(false);
  const currentTarget = targetRead?.database === database ? targetRead : null;
  const targetError = Boolean(applianceId && currentTarget?.found === false);
  const loadingAppliance = Boolean(applianceId) && !currentTarget;
  const applianceAvailable = !applianceId || currentTarget?.found === true;
  const analyzing = analysis?.state === 'pending';
  const previous = analysis && analysis.state !== 'pending' ? analysis : null;
  const retainedDigest = previous?.manualDigest ?? savedContext?.appliance.analysis?.manualSource?.sha256;

  useEffect(() => {
    if (!applianceId) return;
    let cancelled = false;
    void loadApplianceCareReviewContext(database, applianceId).then(context => {
      if (cancelled) return;
      setSavedContext(context);
      setTargetRead({ database, found: Boolean(context) });
      if (!context) return;
      setCategory(context.appliance.category ?? '');
    }).catch(() => {
      if (!cancelled) { setSavedContext(null); setTargetRead({ database, found: false }); }
    });
    return () => { cancelled = true; };
  }, [applianceId, database, targetRetry]);

  const verified = result?.status === 'verified' ? result : undefined;
  const invalidManual = result?.status === 'error' && result.code === 'INVALID_MANUAL';
  const verifiedName = verified ? applianceDisplayName(verified.product) : '';
  const primaryName = verified ? appliancePrimaryName({ ...verified.product, analysis: verified.analysis }, verifiedName) : '';
  const modelPage = verified?.analysis.manualSource && manualModelPageLabel(verified.product.modelNumber, verified.product.modelPages);
  const cycleBaseline = verified && savedContext ? defaultApplianceCycles(verified.analysis, savedContext.chores) : null;
  const cyclesChanged = Boolean(cycleBaseline && verified?.analysis.tasks.some((_, index) => (cycleValues[index] ?? '').normalize('NFKC').trim() !== cycleBaseline[index]));

  const analyze = async () => {
    if (savingRef.current || pickingRef.current || analyzing || !applianceAvailable || invalidManual) return;
    if (!canAnalyze || !owner) { setMessage('ログインと正規端末の確認が済むまで家電AIは利用できません。'); return; }
    savingRef.current = true;
    setWorking(true);
    setPreparing(true);
    setMessage(null);
    setSavedNotice(null);
    setReceived(null);
    setAnalysisSaved(false);
    setDisplayError(false);
    try {
      const id = await trackSubmission(async () => {
        const stored = !manualRef.current && retainedDigest ? await readApplianceManual(database, retainedDigest) : null;
        const submitted = manualRef.current ?? (stored && { base64: stored, rightsConfirmed: true as const });
        if (!submitted) throw new Error('取扱説明書PDFを選んでください。');
        const { startAnalysisWork } = await import('@/platform/appliance-care/analysis-work');
        return startAnalysisWork(database, { owner, target: { applianceId }, filename: manualRef.current ? filename : previous?.filename ?? savedContext?.appliance.displayName,
          ...(savedContext && applianceId ? { basis: { personalUpdatedAt: savedContext.appliance.updatedAt } } : {}),
          request: { identifyFromManual: true, manual: submitted,
            ...(savedContext && applianceId ? { manufacturer: savedContext.appliance.manufacturer, productName: savedContext.appliance.productName,
              modelNumber: savedContext.appliance.modelNumber, category: savedContext.appliance.category, forceReanalysis: true } : {}) } });
      });
      setSelectedWorkId(id);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '解析に失敗しました。');
    } finally {
      savingRef.current = false;
      setWorking(false);
      setPreparing(false);
    }
  };

  const refreshSavedAppliance = useCallback(async (verifiedResult: ProductVerifiedResponse) => {
    if (!savedApplianceId.current) return;
    try {
      const context = await loadApplianceCareReviewContext(database, savedApplianceId.current);
      if (!context) throw new Error('保存した家電を読み込めませんでした。');
      if (context.appliance.analysis.analyzedAt !== verifiedResult.analysis.analyzedAt
        || context.appliance.analysis.manualSource?.sha256 !== verifiedResult.analysis.manualSource?.sha256) {
        throw new Error('家電の解析結果が更新されました。');
      }
      await refresh();
      if (readError?.()) throw new Error('家電一覧を読み直せませんでした。');
      setSavedContext(context);
      setCycleValues(defaultApplianceCycles(verifiedResult.analysis, context.chores));
      setDisplayError(false);
    } catch { setDisplayError(true); }
  }, [database, refresh, readError]);
  const retryDisplay = async () => {
    if (!verified || savingRef.current || pickingRef.current) return;
    savingRef.current = true; setWorking(true);
    try { await refreshSavedAppliance(verified); }
    finally { savingRef.current = false; setWorking(false); }
  };
  const persistAnalysis = useCallback(async (verifiedResult: ProductVerifiedResponse, values?: Record<number, string>) => {
    const approvedTasks = values ? automaticApplianceTasks(verifiedResult.analysis, values) : verifiedResult.analysis.tasks.map(task => ({ task }));
    const modelPages = verifiedResult.analysis.manualSource && manualModelPages(verifiedResult.product.modelNumber, verifiedResult.product.modelPages);
    const saved = await saveReviewedApplianceCare(database, {
      ...(savedApplianceId.current ? { applianceId: savedApplianceId.current } : {}),
      manufacturer: verifiedResult.product.manufacturer,
      productName: verifiedResult.product.productName,
      modelNumber: verifiedResult.product.modelNumber,
      category: verifiedResult.product.category ?? category,
      officialProductUrl: verifiedResult.officialSources.productUrl,
      manualUrl: verifiedResult.officialSources.manualUrl,
    }, { ...verifiedResult.analysis, ...(modelPages ? { modelPages } : {}) }, approvedTasks, undefined, expectedAnalysisUpdate.current);
    savedApplianceId.current = saved.applianceId;
    setAnalysisSaved(true);
    setSavedNotice(`解析結果を保存しました${saved.scheduledTaskCount ? `・定期予定${saved.scheduledTaskCount}件` : ''}${saved.duplicateTaskCount ? `・同名の登録済み${saved.duplicateTaskCount}件` : ''}`);
    await refreshSavedAppliance(verifiedResult);
  }, [database, category, refreshSavedAppliance]);

  useEffect(() => {
    if (!focused || !owner || !applianceAvailable || !analysis?.result || appliedWork.current === analysis.id || savingRef.current || working) return;
    appliedWork.current = analysis.id;
    const output = analysis.result;
    if (output.status === 'verified') savingRef.current = true;
    void Promise.resolve().then(async () => {
      setReceived({ owner, result: output });
      if (output.status !== 'verified') return;
      setWorking(true);
      setAnalysisSaved(false);
      setMessage(null);
      setSavedNotice(null);
      savedApplianceId.current = applianceId ?? `appliance.analysis.${analysis.id}`;
      const context = await loadApplianceCareReviewContext(database, savedApplianceId.current!);
      if (applianceId && !context) throw new Error('登録した家電を読み込めませんでした。');
      const values = defaultApplianceCycles(output.analysis, context?.chores);
      setCycleValues(values);
      expectedAnalysisUpdate.current = analysis.basis?.personalUpdatedAt ?? context?.appliance.updatedAt ?? null;
      if (context?.appliance.analysis?.analyzedAt === output.analysis.analyzedAt
        && context.appliance.analysis?.manualSource?.sha256 === analysis.manualDigest) {
        setAnalysisSaved(true);
        await refreshSavedAppliance(output);
      } else {
        if (applianceId && context && !analysis.basis?.personalUpdatedAt && Date.parse(context.appliance.updatedAt) > analysis.createdAt) {
          expectedAnalysisUpdate.current = null;
          throw new Error('解析の開始後に家電が更新されました。最新の家電を開いてください。');
        }
        await persistAnalysis(output);
      }
      await deviceAnalysisWork(database).remove(owner, analysis.id);
    }).catch(cause => {
      setMessage(cause instanceof Error ? `解析結果を保存できませんでした：${cause.message}` : '解析結果を保存できませんでした。');
    }).finally(() => { savingRef.current = false; setWorking(false); });
  }, [analysis, applianceAvailable, applianceId, database, focused, owner, persistAnalysis, refreshSavedAppliance, working]);

  const saveChanges = async () => {
    if (!verified || displayError || savingRef.current || pickingRef.current) return;
    savingRef.current = true;
    setWorking(true);
    setMessage(null);
    setSavedNotice(null);
    try {
      if (analysisSaved) {
        if (!savedContext || !cycleBaseline) throw new Error('保存した家電を読み直してください。');
        const edits = automaticApplianceTasks(verified.analysis, cycleValues).flatMap(({ task, userIntervalDays }, index) => {
          if ((cycleValues[index] ?? '').normalize('NFKC').trim() === cycleBaseline[index]) return [];
          const chore = findApplianceTaskChore(savedContext.appliance, savedContext.chores, task.name);
          return [{ taskName: task.name, expectedCadence: applianceTaskCadenceKey(chore), days: userIntervalDays }];
        });
        await saveReviewedApplianceCycles(database, savedContext.appliance.id, savedContext.appliance.updatedAt, edits);
        await refreshSavedAppliance(verified);
        setSavedNotice('周期の変更を保存しました');
      } else await persistAnalysis(verified, cycleValues);
      if (owner && analysis?.id === appliedWork.current) await deviceAnalysisWork(database).remove(owner, analysis.id);
    }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : '家電情報を保存できませんでした。'); }
    finally { savingRef.current = false; setWorking(false); }
  };

  const openSavedAppliance = () => {
    if (!savedApplianceId.current) return;
    router.push({ pathname: '/manual/appliances/[id]', params: { id: savedApplianceId.current, ...(returnTo ? { returnTo } : {}) } });
  };

  const manualForm = <ManualAnalysisForm retained={Boolean(retainedDigest)} hasManual={Boolean(manual)}
    filename={analyzing ? analysis?.filename : filename ?? analysis?.filename} phase={analyzing ? 'analyzing' : preparing ? 'preparing' : undefined}
    picking={picking} canAnalyze={canAnalyze} reanalysis={Boolean(applianceId)} reviewing={Boolean(verified)}
    invalidManual={invalidManual ? result.message : undefined}
    usage={result?.usage} onReady={setCanAnalyze} onPickingChange={value => {
      if (value && (savingRef.current || analyzing)) return false;
      pickingRef.current = value; setPicking(value);
    }}
    disabled={!applianceAvailable} inputDisabled={!applianceAvailable || working}
    onManual={(value, name) => {
      if (!value || savingRef.current) return;
      if (analysisSaved && savedApplianceId.current) setApplianceId(savedApplianceId.current);
      setSelectedWorkId(undefined);
      manualRef.current = value; setManual(value); setFilename(name); setReceived(null); setAnalysisSaved(false); setMessage(null); setSavedNotice(null); setDisplayError(false);
    }} onAnalyze={() => void analyze()} />;

  const header = <SettingsHeader title={verified ? '解析結果' : applianceId ? 'PDFを再解析' : '家電を追加'} onBack={() => { if (returnTo) router.dismissTo(returnTo); else router.back(); }} />;
  if (selectedWorkId && !analysis && !result && !preparing) return <Page header={header}>
    <Text accessibilityRole={workReadFailed || analysis === null || !owner ? 'alert' : undefined} style={styles.body}>
      {workReadFailed ? '保存した解析を読み込めませんでした。' : !owner || analysis === null ? 'この解析は見つかりませんでした。' : '保存した解析を読み込んでいます。'}
    </Text>
    {workReadFailed ? <AppButton title="再読み込み" onPress={retryWorkRead} /> : null}
  </Page>;
  return (
    <Page keyboardAware header={header}>
      {targetError ? <Card><Text accessibilityRole="alert" style={styles.message}>登録した家電を読み込めませんでした。</Text>
        <AppButton title="家電を再読込" variant="secondary" onPress={() => { setTargetRead(null); setTargetRetry(before => before + 1); }} /></Card> : null}
      {loadingAppliance ? <Text style={styles.note}>家電を読み込んでいます。</Text> : null}
      {message ? <Text accessibilityRole="alert" style={styles.message}>{message}</Text> : null}
      {displayError ? <Card><Text accessibilityRole="alert" style={styles.message}>保存済みです。表示を更新できませんでした。</Text>
        <AppButton title="表示を再読込" variant="secondary" disabled={working || picking} onPress={() => void retryDisplay()} /></Card> : null}
      {result?.status === 'not_found' ? (
        <Card><Text style={styles.resultTitle}>製品不明</Text><Text style={styles.body}>{result.message}</Text></Card>
      ) : null}
      {result?.status === 'error' && !invalidManual ? (
        <Card><Text style={styles.resultTitle}>{errorTitle(result)}</Text><Text accessibilityRole="alert" style={styles.body}>{result.message}</Text></Card>
      ) : null}
      {result?.status === 'ambiguous' ? <Card><Text style={styles.body}>PDFから製品を特定できませんでした。別の取扱説明書PDFを選んでください。</Text></Card> : null}

      {verified ? (
        <>
          <Pressable accessibilityRole={analysisSaved ? 'button' : undefined}
            accessibilityLabel={analysisSaved ? '保存した家電のお手入れ詳細を開く' : undefined} disabled={!analysisSaved}
            accessibilityValue={analysisSaved ? { text: primaryName } : undefined}
            onPress={openSavedAppliance} style={styles.resultNavigation}>
            <Text style={styles.resultTitle}>{primaryName}</Text>
            {primaryName !== verifiedName ? <Text style={styles.note}>{verifiedName}</Text> : null}
            {analysisSaved ? <>
              <Text accessibilityLiveRegion="polite" style={styles.note}>{savedNotice ?? '保存済み'}</Text>
              <ActionLabel label="お手入れ詳細を開く" style={styles.link} />
            </>
              : <Text accessibilityLiveRegion="polite" style={styles.note}>{working ? '解析結果を保存中…' : '解析結果は未保存です。'}</Text>}
          </Pressable>
          {!analysisSaved && !working ? <AppButton title="解析結果の保存を再試行" variant="secondary" onPress={() => void saveChanges()} disabled={picking} /> : null}
          {modelPage ? <Text style={styles.note}>{modelPage}</Text> : null}
        </>
      ) : null}

      {!verified ? manualForm : null}
      {verified ? (
        <>
          {verified.analysis.tasks.length ? <SectionHeading title="お手入れ項目・周期の変更" /> : <Text style={styles.note}>お手入れ項目はありません。</Text>}
          {verified.analysis.tasks.map((task, index) => (
            <TaskReviewCard
              key={`${index}-${task.name}`}
              task={task}
              working={working || displayError}
              cycleValue={cycleValues[index] ?? ''}
              onChangeCycle={(value) => setCycleValues((current) => ({ ...current, [index]: value }))}
            />
          ))}
          {analysisSaved && cyclesChanged ? <AppButton title={working ? '保存中…' : '周期の変更を保存'} onPress={() => void saveChanges()} disabled={working || picking || displayError} /> : null}
          {manualForm}
        </>
      ) : null}
    </Page>
  );
}

function TaskReviewCard({ task, working, cycleValue, onChangeCycle }: {
  task: ApplianceCareTaskDraft;
  working: boolean;
  cycleValue: string;
  onChangeCycle: (value: string) => void;
}) {
  return <MaintenanceTaskCard task={task} schedule={<View>
      <View style={styles.cycleRow}>
        <View style={styles.flexCopy}>
          <Text style={styles.fieldLabel}>周期</Text>
        </View>
        <NumberInputField value={cycleValue} editable={!working} onChangeText={onChangeCycle} accessibilityLabel={`${task.name}の周期`} placeholder="任意" />
      </View>
      <Text style={styles.note}>{task.recommendedIntervalDays === undefined ? '空欄なら定期予定なし' : `空欄なら推奨の${task.recommendedIntervalDays}日`}</Text>
    </View>} />;
}

function errorTitle(error: ProductAnalysisErrorResponse): string {
  if (error.code === 'AI_SERVICE_NO_RESULT') return 'AIサービスの応答を取得できませんでした';
  if (error.code === 'REINSTALL_ACCOUNT_LOCKED') return '当月のアカウント制限';
  if (error.code === 'DEVICE_VERIFICATION_REQUIRED' || error.code === 'DEVICE_VERIFICATION_UNAVAILABLE') return '安全な端末確認が必要です';
  if (error.code === 'MONTHLY_LIMIT_REACHED') return '今月の利用上限';
  if (error.code === 'SERVICE_LIMIT_REACHED') return '本日の受付上限';
  if (error.code === 'AUTHENTICATION_REQUIRED' || error.code === 'ACCESS_DENIED') return '利用者認証を確認してください';
  if (error.code === 'ANALYSIS_INTERRUPTED') return '解析が中断されました';
  if (error.code === 'JOB_NOT_FOUND' || error.code === 'REQUEST_CONFLICT') return '解析の受付を確認してください';
  if (error.code === 'MANUAL_NOT_FOUND') return '説明書なし';
  if (error.code === 'ANALYSIS_FAILED' || error.code === 'AI_ANALYSIS_FAILED' || error.code === 'INVALID_AI_OUTPUT') return '解析失敗';
  if (error.code === 'PRODUCT_NOT_FOUND') return '製品不明';
  return '解析できませんでした';
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  resultNavigation: { borderWidth: 1, borderColor: palette.border, borderRadius: 16, padding: 16, gap: 6 },
  fieldLabel: { ...typography.label, color: palette.ink, fontWeight: '700' },
  note: { ...typography.caption, color: palette.muted },
  body: { ...typography.body, color: palette.muted },
  message: { ...typography.body, color: palette.warning },
  resultTitle: { ...typography.section, color: palette.ink, fontWeight: '700' },
  link: { ...typography.label, color: palette.accent, fontWeight: '600' },
  cycleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  flexCopy: { flex: 1, gap: 3 },
});
