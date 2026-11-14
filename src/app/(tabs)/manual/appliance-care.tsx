import { router, useLocalSearchParams } from 'expo-router';
import { useContext, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionLabel, AppButton, Card, Page, SectionHeading, palette, typography } from '@/components/planner-ui';
import { NumberInputField } from '@/components/number-input-field';
import type { UploadedManualInput, ApplianceCareApiResponse, ProductAnalysisErrorResponse, ProductVerifiedResponse } from '@/features/appliance-care/api-contracts';
import { ManualAnalysisForm } from '@/features/appliance-care/manual-analysis-form';
import { MaintenanceTaskCard } from '@/features/appliance-care/appliance-detail-content';
import { SettingsHeader } from '@/components/settings-header';
import { analyzeApplianceCareRequest } from '@/features/appliance-care/api-client';
import { useAbortApplianceRequestOnLeave } from '@/features/appliance-care/use-abort-on-leave';
import type { ApplianceCareTaskDraft } from '@/features/appliance-care/contracts';
import { automaticApplianceTasks, defaultApplianceCycles } from '@/features/appliance-care/auto-save-policy';
import { applianceDisplayName, appliancePrimaryName } from '@/features/appliance-care/display-name';
import { applianceAnalysisDate } from '@/features/appliance-care/analysis-date';
import { usePlannerData } from '@/hooks/use-planner-data';
import { loadApplianceCareReviewContext, saveReviewedApplianceCare } from '@/platform/storage/repository';
import type { ApplianceCareReviewContext } from '@/platform/storage/repository';
import { readApplianceManual } from '@/platform/storage/appliance-manuals';
import { WorkspaceContext } from '@/contexts/workspace-context';
import type { V2SharedWorkspace } from '@/platform/sharing/workspace-types';
import { supportsRetainedManuals } from '@/features/sharing/v2/payload-schema';

export default function ApplianceCareScreen() {
  const params = useLocalSearchParams<{ applianceId?: string; returnTo?: string }>();
  const applianceId = Array.isArray(params.applianceId) ? params.applianceId[0] : params.applianceId;
  const returnToParam = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = returnToParam === '/chores' ? '/chores' : returnToParam === '/manual' ? '/manual' : undefined;
  const { database, refresh, snapshot } = usePlannerData({ personal: true });
  const workspace = useContext(WorkspaceContext); const workspaceRef = useRef(workspace);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  const analysisTarget = useRef<V2SharedWorkspace | null>(null);
  const [canAnalyze, setCanAnalyze] = useState(false);
  const [manual, setManual] = useState<UploadedManualInput>();
  const manualRef = useRef<UploadedManualInput | undefined>(undefined); const analysisManual = useRef<UploadedManualInput | undefined>(undefined);
  const [retainedManual, setRetainedManual] = useState<UploadedManualInput>();
  const manualTouched = useRef(false);
  const [category, setCategory] = useState('');
  const [result, setResult] = useState<ApplianceCareApiResponse | null>(null);
  const savedApplianceId = useRef<string | undefined>(applianceId);
  const [analysisSaved, setAnalysisSaved] = useState(false);
  const savingRef = useRef(false);
  const analysisRequest = useRef<AbortController | null>(null);
  const [cycleValues, setCycleValues] = useState<Record<number, string>>({});
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [savedContext, setSavedContext] = useState<ApplianceCareReviewContext | null>(null);
  const loadingAppliance = Boolean(applianceId) && !savedContext && !message;
  const beginRequest = useAbortApplianceRequestOnLeave(analysisRequest);

  useEffect(() => {
    if (!applianceId) return;
    let cancelled = false;
    void loadApplianceCareReviewContext(database, applianceId).then(async (context) => {
      if (cancelled) return;
      setSavedContext(context);
      if (!context) {
        setMessage('登録した家電を読み込めませんでした。家事一覧からもう一度開いてください。');
        return;
      }
      const digest = context.appliance.analysis.manualSource?.sha256;
      if (digest) {
        const base64 = await readApplianceManual(database, digest).catch(() => null);
        if (cancelled) return;
        if (base64 && !manualTouched.current) { const retained: UploadedManualInput = { base64, rightsConfirmed: true }; setRetainedManual(retained); manualRef.current = retained; setManual(retained); }
      }
      setCategory(context.appliance.category ?? '');
    }).catch(() => {
      if (!cancelled) setMessage('登録した家電を読み込めませんでした。');
    });
    return () => { cancelled = true; };
  }, [applianceId, database]);

  const verified = result?.status === 'verified' ? result : undefined;
  const verifiedName = verified ? applianceDisplayName(verified.product) : '';
  const primaryName = verified ? appliancePrimaryName({ ...verified.product, analysis: verified.analysis }, verifiedName) : '';

  const analyze = async () => {
    if (savingRef.current) return;
    if (!canAnalyze) { setMessage('ログインと正規端末の確認が済むまで家電AIは利用できません。'); return; }
    const context = workspaceRef.current;
    if (context?.group && !context.active) { setMessage('グループの確認後に解析できます。'); return; }
    analysisTarget.current = context?.active?.protocol === 2 ? context.active : null;
    if (analysisTarget.current && !supportsRetainedManuals(analysisTarget.current.roster()?.body.schedulerVersion ?? '')) {
      setMessage('解析前に、グループ管理で互換更新を行ってください。'); return;
    }
    const request = { identifyFromManual: true as const, manual: manualRef.current,
      ...(savedContext ? { manufacturer: savedContext.appliance.manufacturer, productName: savedContext.appliance.productName,
        modelNumber: savedContext.appliance.modelNumber, category: savedContext.appliance.category, forceReanalysis: true } : {}) };
    if (!request.manual) { setMessage('取扱説明書PDFを選んでください。'); return; }
    analysisManual.current = request.manual;
    savingRef.current = true;
    const controller = beginRequest(() => { savingRef.current = false; setWorking(false); });
    setWorking(true);
    setMessage(null);
    setResult(null);
    setAnalysisSaved(false);
    let responseReceived = false;
    try {
      const nextResult = await analyzeApplianceCareRequest(request, undefined, undefined, undefined, controller.signal);
      if (controller.signal.aborted || analysisRequest.current !== controller) return;
      // Polling is finished. Leaving now must not release the separate, already-started local save.
      responseReceived = true; analysisRequest.current = null;
      setResult(nextResult);
      if (nextResult.status === 'verified') {
        const values = defaultApplianceCycles(nextResult.analysis, savedContext?.chores);
        setCycleValues(values);
        if (snapshot?.sharing) {
          setMessage('内容を確認してから、共有グループへ保存してください。');
        } else try {
          await persistAnalysis(nextResult, values);
        } catch (cause) {
          setMessage(cause instanceof Error ? `解析結果を保存できませんでした：${cause.message}` : '解析結果を保存できませんでした。');
        }
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setMessage(cause instanceof Error ? cause.message : '解析に失敗しました。');
    } finally {
      if (responseReceived || analysisRequest.current === controller) {
        if (analysisRequest.current === controller) analysisRequest.current = null;
        savingRef.current = false; setWorking(false);
      }
    }
  };

  const persistAnalysis = async (verifiedResult: ProductVerifiedResponse, values: Record<number, string>) => {
    const approvedTasks = automaticApplianceTasks(verifiedResult.analysis, values);
    const saved = await saveReviewedApplianceCare(database, {
      ...(savedApplianceId.current ? { applianceId: savedApplianceId.current } : {}),
      manufacturer: verifiedResult.product.manufacturer,
      productName: verifiedResult.product.productName,
      modelNumber: verifiedResult.product.modelNumber,
      category: verifiedResult.product.category ?? category,
      officialProductUrl: verifiedResult.officialSources.productUrl,
      manualUrl: verifiedResult.officialSources.manualUrl,
    }, verifiedResult.analysis, approvedTasks, analysisManual.current);
    savedApplianceId.current = saved.applianceId;
    const target = analysisTarget.current;
    if (target) {
      if (workspaceRef.current?.active !== target || workspaceRef.current.userId !== target.userId) throw new Error('共有先が変わりました。保存した家電は保持しています。');
      await target.session.controller.actions.reviewAppliance({ reviewed: true, result: verifiedResult, manual: analysisManual.current,
        addTaskNames: verifiedResult.analysis.tasks.map(task => task.name) });
    }
    setAnalysisSaved(true);
    const context = await loadApplianceCareReviewContext(database, saved.applianceId);
    setSavedContext(context);
    setCycleValues(defaultApplianceCycles(verifiedResult.analysis, context?.chores));
    await refresh();
    setMessage(`解析結果を保存し、${saved.scheduledTaskCount}件を予定へ登録しました。${saved.noCycleTaskCount ? ` 周期なしの${saved.noCycleTaskCount}件も説明を保存しました。` : ''}${saved.duplicateTaskCount ? ` 同名の${saved.duplicateTaskCount}件は重複登録していません。` : ''}`);
  };

  const saveChanges = async () => {
    if (!verified || savingRef.current) return;
    savingRef.current = true;
    setWorking(true);
    setMessage(null);
    try { await persistAnalysis(verified, cycleValues); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : '家電情報を保存できませんでした。'); }
    finally { savingRef.current = false; setWorking(false); }
  };

  const openSavedAppliance = () => {
    if (!savedApplianceId.current) return;
    router.push({ pathname: '/manual/appliances/[id]', params: { id: savedApplianceId.current, ...(returnTo ? { returnTo } : {}) } });
  };

  return (
    <Page keyboardAware header={<SettingsHeader title={applianceId ? 'PDFを再解析' : '家電を追加'} onBack={() => { analysisRequest.current?.abort(); if (returnTo) router.dismissTo(returnTo); else router.back(); }} />}>
      <ManualAnalysisForm retained={retainedManual} working={working} canAnalyze={canAnalyze} reanalysis={Boolean(savedContext)}
        shared={Boolean(workspace?.group)} usage={result?.usage} onReady={setCanAnalyze}
        disabled={!manual || loadingAppliance || (Boolean(applianceId) && !savedContext)} inputDisabled={loadingAppliance || working}
        onManual={value => {
          if (savingRef.current) return;
          manualTouched.current = true; manualRef.current = value; setManual(value); setResult(null); setAnalysisSaved(false); setMessage(null);
        }} onAnalyze={() => void analyze()} onCancel={() => analysisRequest.current?.abort()} />

      {message ? <Card><Text style={message.includes('件を予定へ登録') ? styles.savedMessage : styles.message}>{message}</Text></Card> : null}
      {result?.status === 'not_found' ? (
        <Card><Text style={styles.resultTitle}>製品不明</Text><Text style={styles.body}>{result.message}</Text></Card>
      ) : null}
      {result?.status === 'error' ? (
        <Card><Text style={styles.resultTitle}>{errorTitle(result)}</Text><Text style={styles.body}>{result.message}</Text></Card>
      ) : null}
      {result?.status === 'ambiguous' ? <Card><Text style={styles.body}>PDFから製品を特定できませんでした。別の取扱説明書PDFを選んでください。</Text></Card> : null}

      {verified ? (
        <>
          <Pressable accessibilityRole="button" accessibilityLabel="保存した家電のお手入れ詳細を開く" disabled={!analysisSaved}
            onPress={openSavedAppliance} style={styles.resultNavigation}>
            <Text style={styles.resultTitle}>{primaryName}</Text>
            {primaryName !== verifiedName ? <Text style={styles.note}>{verifiedName}</Text> : null}
            {analysisSaved ? <ActionLabel label="保存したお手入れ内容を見る" style={styles.link} /> : <Text style={styles.link}>解析結果は未保存です。下の保存ボタンから再試行できます。</Text>}
          </Pressable>
          <Card style={styles.verifiedCard}>
            <Text style={styles.verifiedLabel}>選択した説明書の解析結果・内容を確認してください</Text>
            <Text style={styles.note}>解析日時：{applianceAnalysisDate(verified.analysis.analyzedAt)} · {analysisSaved ? '解析結果を保存済みです。内容をご確認ください' : '未保存です'}</Text>
          </Card>
          <SectionHeading title="お手入れ項目・周期の変更" />
          {verified.analysis.tasks.map((task, index) => (
            <TaskReviewCard
              key={`${index}-${task.name}`}
              task={task}
              working={working}
              cycleValue={cycleValues[index] ?? ''}
              onChangeCycle={(value) => setCycleValues((current) => ({ ...current, [index]: value }))}
            />
          ))}
          <AppButton title={working ? '保存中…' : analysisSaved ? '周期の変更を保存' : snapshot?.sharing ? '内容を確認して共有グループへ保存' : '解析結果の保存を再試行'} onPress={() => void saveChanges()} disabled={working} />
          <Text style={styles.note}>周期を入力した項目だけ定期予定に追加します。</Text>
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
      {task.recommendedIntervalDays === undefined ? <Text style={styles.note}>空欄なら定期予定に追加しません。</Text> : null}
    </View>} />;
}

function errorTitle(error: ProductAnalysisErrorResponse): string {
  if (error.code === 'AI_SERVICE_NO_RESULT') return 'AIサービスの応答を取得できませんでした';
  if (error.code === 'REINSTALL_ACCOUNT_LOCKED') return '当月のアカウント制限';
  if (error.code === 'DEVICE_VERIFICATION_REQUIRED' || error.code === 'DEVICE_VERIFICATION_UNAVAILABLE') return '安全な端末確認が必要です';
  if (error.code === 'INVALID_MANUAL') return '説明書PDFを確認してください';
  if (error.code === 'MONTHLY_LIMIT_REACHED') return '今月の利用上限';
  if (error.code === 'SERVICE_LIMIT_REACHED') return '本日の受付上限';
  if (error.code === 'AUTHENTICATION_REQUIRED' || error.code === 'ACCESS_DENIED') return '利用者認証を確認してください';
  if (error.code === 'ANALYSIS_INTERRUPTED') return '解析が中断されました';
  if (error.code === 'JOB_NOT_FOUND' || error.code === 'REQUEST_CONFLICT') return '解析の受付を確認してください';
  if (error.code === 'MANUAL_NOT_FOUND') return '説明書なし';
  if (error.code === 'ANALYSIS_FAILED' || error.code === 'AI_ANALYSIS_FAILED' || error.code === 'INVALID_AI_OUTPUT') return '解析失敗';
  if (error.code === 'PRODUCT_NOT_FOUND') return '製品不明';
  return '一時的な通信失敗';
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  resultNavigation: { borderWidth: 1, borderColor: palette.border, borderRadius: 16, padding: 16, gap: 6 },
  fieldLabel: { ...typography.label, color: palette.ink, fontWeight: '700' },
  note: { ...typography.caption, color: palette.muted },
  body: { ...typography.body, color: palette.muted },
  message: { ...typography.body, color: palette.warning },
  savedMessage: { ...typography.body, color: palette.accent, fontWeight: '600' },
  resultTitle: { ...typography.section, color: palette.ink, fontWeight: '700' },
  verifiedCard: { backgroundColor: palette.accentSoft, borderColor: palette.border },
  verifiedLabel: { ...typography.caption, color: palette.accent, fontWeight: '800' },
  link: { ...typography.label, color: palette.accent, fontWeight: '700', textDecorationLine: 'underline' },
  cycleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  flexCopy: { flex: 1, gap: 3 },
});
