import { FormTextInput as TextInput } from '../../../components/form-text-input';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionLabel, AppButton, BackButton, Card, Page, ScreenHeading, SectionHeading, palette, typography } from '@/components/planner-ui';
import { NumberInputField } from '@/components/number-input-field';
import type { UploadedManualInput, ApplianceCareAnalysisStage, ApplianceCareApiResponse, ProductAnalysisErrorResponse, ProductVerifiedResponse } from '@/features/appliance-care/api-contracts';
import { ManualUploadInput } from '@/features/appliance-care/manual-upload-input';
import { ApplianceAiAccount } from '@/features/appliance-care/ai-account';
import { OfficialLink } from '@/features/appliance-care/appliance-detail-content';
import { analyzeApplianceCareRequest } from '@/features/appliance-care/api-client';
import { useAbortApplianceRequestOnLeave } from '@/features/appliance-care/use-abort-on-leave';
import type { ApplianceCareTaskDraft } from '@/features/appliance-care/contracts';
import { automaticApplianceTasks, defaultApplianceCycles } from '@/features/appliance-care/auto-save-policy';
import { applianceCategoryLabel, searchApplianceCategories } from '@/features/appliance-care/categories';
import { applianceDisplayName } from '@/features/appliance-care/display-name';
import { usePlannerData } from '@/hooks/use-planner-data';
import { loadApplianceCareReviewContext, saveReviewedApplianceCare } from '@/platform/storage/repository';
import type { ApplianceCareReviewContext } from '@/platform/storage/repository';

export default function ApplianceCareScreen() {
  const params = useLocalSearchParams<{ applianceId?: string; productName?: string; returnTo?: string }>();
  const applianceId = Array.isArray(params.applianceId) ? params.applianceId[0] : params.applianceId;
  const requestedProductName = Array.isArray(params.productName) ? params.productName[0] : params.productName;
  const returnToParam = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = returnToParam === '/chores' ? '/chores' : returnToParam === '/manual' ? '/manual' : undefined;
  const { database, refresh, snapshot } = usePlannerData();
  const [canAnalyze, setCanAnalyze] = useState(false);
  const [manual, setManual] = useState<UploadedManualInput>();
  const [manufacturer, setManufacturer] = useState('');
  const [productName, setProductName] = useState(requestedProductName ?? '');
  const [modelNumber, setModelNumber] = useState('');
  const [category, setCategory] = useState('');
  const [result, setResult] = useState<ApplianceCareApiResponse | null>(null);
  const [categoryQuery, setCategoryQuery] = useState('');
  const savedApplianceId = useRef<string | undefined>(applianceId);
  const [analysisSaved, setAnalysisSaved] = useState(false);
  const savingRef = useRef(false);
  const analysisRequest = useRef<AbortController | null>(null);
  const [cycleValues, setCycleValues] = useState<Record<number, string>>({});
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stage, setStage] = useState<ApplianceCareAnalysisStage>('product_verification');
  const [savedContext, setSavedContext] = useState<ApplianceCareReviewContext | null>(null);
  const loadingAppliance = Boolean(applianceId) && !savedContext && !message;
  const beginRequest = useAbortApplianceRequestOnLeave(analysisRequest);

  useEffect(() => {
    if (!applianceId) return;
    let cancelled = false;
    void loadApplianceCareReviewContext(database, applianceId).then((context) => {
      if (cancelled) return;
      setSavedContext(context);
      if (!context) {
        setMessage('登録した家電を読み込めませんでした。家事一覧からもう一度開いてください。');
        return;
      }
      setManufacturer(context.appliance.manufacturer);
      setProductName(context.appliance.productName);
      setModelNumber(context.appliance.modelNumber);
      setCategory(context.appliance.category ?? '');
      setCategoryQuery(applianceCategoryLabel(context.appliance.category) ?? '');
    }).catch(() => {
      if (!cancelled) setMessage('登録した家電を読み込めませんでした。');
    });
    return () => { cancelled = true; };
  }, [applianceId, database]);

  const verified = result?.status === 'verified' ? result : undefined;

  const analyze = async () => {
    if (savingRef.current) return;
    if (!canAnalyze) { setMessage('ログインと正規端末の確認が済むまで家電AIは利用できません。'); return; }
    const request = { manufacturer, productName, modelNumber, category, manual, ...(savedContext ? { forceReanalysis: true } : {}) };
    if (!request.manual) { setMessage('取扱説明書PDFを選び、送信の確認をしてください。'); return; }
    if (!request.modelNumber.trim()) {
      setMessage('型番を確認してください。型番を確認してから解析できます。');
      return;
    }
    if ([request.manufacturer, request.productName].some((value) => !value.trim())) {
      setMessage('メーカー名・製品名を入力してください。');
      return;
    }
    savingRef.current = true;
    const controller = beginRequest(() => { savingRef.current = false; setWorking(false); });
    setWorking(true);
    setMessage(null);
    setResult(null);
    setAnalysisSaved(false);
    setStage('product_verification');
    let responseReceived = false;
    try {
      const nextResult = await analyzeApplianceCareRequest(request, undefined, undefined,
        (nextStage) => { if (!controller.signal.aborted) setStage(nextStage); }, controller.signal);
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
    }, verifiedResult.analysis, approvedTasks);
    savedApplianceId.current = saved.applianceId;
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
    <Page keyboardAware footerHasTabBar footer={<BackButton onPress={() => { analysisRequest.current?.abort(); if (returnTo) router.dismissTo(returnTo); else router.back(); }} />}>
      <ScreenHeading
        eyebrow="MANUAL PDF"
        title={applianceId ? '説明書PDFを再解析' : '家電を追加'}
        description="お手持ちの取扱説明書PDFを選んで、お手入れ方法を解析します。PDFと製品が一致することを確認してください。"
      />

      <Card>
        <SectionHeading title="製品情報" />
        <Field label="メーカー名" value={manufacturer} onChangeText={setManufacturer} placeholder="例：Dyson" editable={!savedContext} />
        <Field label="製品名" value={productName} onChangeText={setProductName} placeholder="例：V12 Detect Slim" editable={!savedContext} />
        <Field label="型番" value={modelNumber} onChangeText={(value) => { setModelNumber(value); setMessage(null); }} placeholder="例：SV20" editable={!savedContext} />
        {getOfficialSupportUrl(manufacturer) ? <ExternalLink title="メーカー公式サイトで型番を確認する ↗" url={getOfficialSupportUrl(manufacturer)!} manufacturer={manufacturer} /> : null}
        <Field label="カテゴリ（任意）" value={categoryQuery} onChangeText={(value) => { setCategoryQuery(value); setCategory(''); }} placeholder="例：掃除機、せんたくき" editable={!savedContext && !working} />
        {!savedContext && categoryQuery.trim() && !category ? <View style={styles.categoryResults}>
          {searchApplianceCategories(categoryQuery).map((option) => <Pressable key={option.value} accessibilityRole="button" accessibilityLabel={`${option.label}を選択`}
            onPress={() => { setCategory(option.value); setCategoryQuery(option.label); }} style={styles.categoryOption}><Text style={styles.body}>{option.label}</Text></Pressable>)}
        </View> : null}
        {category ? <Text style={styles.note}>選択中：{applianceCategoryLabel(category)}</Text> : null}
        {savedContext ? <Text style={styles.note}>再解析では家電の識別情報を固定します。別の製品は家事一覧から新しく登録してください。</Text> : null}
        <ApplianceAiAccount disabled={working} onReady={setCanAnalyze} />
        <ManualUploadInput disabled={working} onChange={setManual} />
        <Text style={styles.note}>解析時に製品情報と選択したPDFを解析APIとAI提供元へ送信します。APIキーはサーバーだけで管理します。</Text>
        <Text style={styles.note}>端末とアカウントを照合して月5回まで（再解析を含む）。毎月1日9時（日本時間）に更新。受付後の中止・結果検証の失敗は1回に数えます。OpenAIから結果を得られないとサーバーで確認した障害は消費しません。
          {result?.usage ? ` 今月の残り${result.usage.remaining}回。` : ''}</Text>
        <AppButton
          title={loadingAppliance ? '家電を読み込んでいます…' : working ? '解析しています…' : savedContext ? '選択したPDFを再解析' : '選択したPDFを解析'}
          onPress={() => void analyze()}
          disabled={!canAnalyze || !manual || working || loadingAppliance || (Boolean(applianceId) && !savedContext)}
        />
      </Card>

      {working ? (
        <Card style={styles.progressCard}>
          <ActivityIndicator color={palette.accent} />
          <View style={styles.progressCopy}>
            <Text style={styles.resultTitle}>{stage === 'product_verification' ? 'PDFを確認しています' : '説明書PDFを解析しています'}</Text>
            <Text style={styles.note}>完了率は表示せず、処理段階だけを表示します。</Text>
          </View>
        </Card>
      ) : null}

      {message ? <Card><Text style={message.includes('件を予定へ登録') ? styles.savedMessage : styles.message}>{message}</Text></Card> : null}
      {result?.status === 'not_found' ? (
        <Card><Text style={styles.resultTitle}>製品不明</Text><Text style={styles.body}>{result.message}</Text></Card>
      ) : null}
      {result?.status === 'error' ? (
        <Card><Text style={styles.resultTitle}>{errorTitle(result)}</Text><Text style={styles.body}>{result.message}</Text></Card>
      ) : null}
      {result?.status === 'ambiguous' ? (
        <Card>
          <SectionHeading title="候補を確認してください" />
          <Text style={styles.body}>公式情報に複数の候補があります。候補を選ぶと製品名・型番を入力欄へ戻します。必要に応じて内容を編集して再検索してください。</Text>
          {result.candidates.map((candidate, index) => (
            <View key={`${candidate.officialProductUrl}-${index}`} style={styles.candidate}>
              <Text style={styles.resultTitle}>{applianceDisplayName(candidate)}</Text>
              <AppButton title="この候補を入力して再検索" onPress={() => {
                setManufacturer(candidate.manufacturer);
                setProductName(candidate.productName);
                if (candidate.modelNumber) setModelNumber(candidate.modelNumber);
                setCategory('');
                setCategoryQuery('');
                setResult(null);
              }} variant="secondary" compact />
              <ExternalLink title="公式製品情報を開く ↗" url={candidate.officialProductUrl} manufacturer={candidate.manufacturer} />
            </View>
          ))}
        </Card>
      ) : null}

      {verified ? (
        <>
          <Pressable accessibilityRole="button" accessibilityLabel="保存した家電のお手入れ詳細を開く" disabled={!analysisSaved}
            onPress={openSavedAppliance} style={styles.resultNavigation}>
            <Text style={styles.resultTitle}>{applianceDisplayName(verified.product)}</Text>
            {analysisSaved ? <ActionLabel label="保存したお手入れ内容を見る" style={styles.link} /> : <Text style={styles.link}>解析結果は未保存です。下の保存ボタンから再試行できます。</Text>}
          </Pressable>
          <Card style={styles.verifiedCard}>
            <Text style={styles.verifiedLabel}>選択した説明書の解析結果・内容を確認してください</Text>
            {verified.product.category ? <Text style={styles.body}>カテゴリ：{applianceCategoryLabel(verified.product.category)}</Text> : null}
            {verified.officialSources.productUrl ? <ExternalLink title="公式製品情報を開く ↗" url={verified.officialSources.productUrl} manufacturer={verified.product.manufacturer} /> : null}
            <OfficialLink title="公式取扱説明書を開く ↗" url={verified.officialSources.manualUrl} manufacturer={verified.product.manufacturer} />
            <Text style={styles.note}>解析日時：{verified.analysis.analyzedAt} · {analysisSaved ? '解析結果を保存済みです。内容をご確認ください' : '未保存です'}</Text>
          </Card>
          <SectionHeading title="お手入れ項目・周期の変更" />
          {verified.analysis.tasks.map((task, index) => (
            <TaskReviewCard
              key={`${index}-${task.name}`}
              task={task}
              index={index}
              working={working}
              cycleValue={cycleValues[index] ?? ''}
              onChangeCycle={(value) => setCycleValues((current) => ({ ...current, [index]: value }))}
              manufacturer={verified.product.manufacturer}
            />
          ))}
          <AppButton title={working ? '保存中…' : analysisSaved ? '周期の変更を保存' : snapshot?.sharing ? '内容を確認して共有グループへ保存' : '解析結果の保存を再試行'} onPress={() => void saveChanges()} disabled={working} />
          <Text style={styles.note}>具体的なメーカー周期がない項目は周期なしのまま家電詳細に保存し、自動予定には追加しません。周期を入力した項目だけ予定に登録します。</Text>
        </>
      ) : null}
    </Page>
  );
}

function Field({ label, value, onChangeText, placeholder, editable = true }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  editable?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput accessibilityLabel={label} editable={editable} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={palette.muted} style={[styles.input, !editable && styles.inputReadonly]} maxLength={120} autoCapitalize="words" />
    </View>
  );
}

function TaskReviewCard({ task, index, working, cycleValue, onChangeCycle, manufacturer }: {
  task: ApplianceCareTaskDraft;
  index: number;
  working: boolean;
  cycleValue: string;
  onChangeCycle: (value: string) => void;
  manufacturer: string;
}) {
  return (
    <Card>
      <View style={styles.taskHeader}>
        <View style={styles.taskHeading}>
          <Text style={styles.taskIndex}>お手入れ {String(index + 1).padStart(2, '0')}</Text>
          <Text style={styles.resultTitle}>{task.name}</Text>
        </View>
      </View>
      <View style={styles.cycleRow}>
        <View style={styles.flexCopy}>
          <Text style={styles.fieldLabel}>周期</Text>
          {task.recommendedIntervalDays !== undefined
            ? <Text style={styles.body}>メーカー推奨：{task.recommendedIntervalDays}日</Text>
            : <Text style={styles.noCycleTag}>定期予定なし · メーカー指定の具体的周期なし</Text>}
        </View>
        <NumberInputField value={cycleValue} editable={!working} onChangeText={onChangeCycle} accessibilityLabel={`${task.name}の周期`} placeholder="任意" />
      </View>
      {task.recommendedIntervalDays === undefined ? <Text style={styles.note}>周期欄を空のままにすると家電詳細に保存され、カレンダー・自動予定・定期通知には入りません。周期を入力すると、その設定で予定を作ります。</Text> : null}
      {task.recommendedConditions?.map((condition) => <Text key={condition} style={styles.body}>条件：{condition}</Text>)}
      <SectionHeading title="手順" />
      {task.steps.map((step, stepIndex) => <Text key={`${stepIndex}-${step}`} style={styles.body}>{stepIndex + 1}. {step}</Text>)}
      {task.tools.length ? <Text style={styles.body}>道具：{task.tools.join('、')}</Text> : <Text style={styles.body}>必要な道具：記載なし</Text>}
      {task.safetyCautions.length ? (
        <View style={styles.cautionBox}>
          <Text style={styles.cautionTitle}>注意事項</Text>
          {task.safetyCautions.map((caution) => <Text key={caution} style={styles.cautionText}>• {caution}</Text>)}
        </View>
      ) : null}
      {task.estimatedMinutes ? <Text style={styles.note}>所要時間：約{task.estimatedMinutes}分</Text> : null}
      {task.evidence.map((item, evidenceIndex) => (
        <ExternalLink key={`${item.url}-${evidenceIndex}`} title={`出典を見る${item.pageOrSection ? ` · ${item.pageOrSection}` : ''} ↗`} url={item.url} manufacturer={manufacturer} />
      ))}
    </Card>
  );
}

function ExternalLink({ title, url, manufacturer }: { title: string; url: string; manufacturer: string }) {
  return <OfficialLink title={title} url={url} manufacturer={manufacturer} />;
}

function getOfficialSupportUrl(manufacturer: string): string | undefined {
  const normalized = manufacturer.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const urls: Record<string, string> = {
    dyson: 'https://www.dyson.co.jp/support', ダイソン: 'https://www.dyson.co.jp/support',
    panasonic: 'https://panasonic.jp/support/', パナソニック: 'https://panasonic.jp/support/',
    hitachi: 'https://kadenfan.hitachi.co.jp/support/', 日立: 'https://kadenfan.hitachi.co.jp/support/',
    sharp: 'https://jp.sharp/support/', シャープ: 'https://jp.sharp/support/',
  };
  return urls[normalized];
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
  categoryResults: { gap: 6 },
  categoryOption: { borderWidth: 1, borderColor: palette.border, borderRadius: 12, padding: 12 },
  resultNavigation: { borderWidth: 1, borderColor: palette.border, borderRadius: 16, padding: 16, gap: 6 },
  fieldLabel: { ...typography.label, color: palette.ink, fontWeight: '700' },
  input: { ...typography.body, minHeight: 54, borderRadius: 12, borderWidth: 1, borderColor: palette.border, paddingHorizontal: 12, color: palette.ink, backgroundColor: palette.background },
  inputReadonly: { opacity: 0.7 },
  note: { ...typography.caption, color: palette.muted },
  body: { ...typography.body, color: palette.muted },
  message: { ...typography.body, color: palette.warning },
  savedMessage: { ...typography.body, color: palette.accent, fontWeight: '600' },
  resultTitle: { ...typography.section, color: palette.ink, fontWeight: '700' },
  verifiedCard: { backgroundColor: palette.accentSoft, borderColor: palette.border },
  progressCard: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  progressCopy: { flex: 1, gap: 4 },
  verifiedLabel: { ...typography.caption, color: palette.accent, fontWeight: '800' },
  link: { ...typography.label, color: palette.accent, fontWeight: '700', textDecorationLine: 'underline' },
  candidate: { gap: 8, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  taskHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  checkbox: { width: 26, height: 26, borderWidth: 1.5, borderColor: palette.muted, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  checkboxSelected: { backgroundColor: palette.accent, borderColor: palette.accent },
  checkmark: { color: palette.accentInk, fontSize: 17, fontWeight: '800' },
  taskHeading: { flex: 1, gap: 3 },
  taskIndex: { ...typography.caption, color: palette.accent, fontWeight: '800', letterSpacing: 1 },
  cycleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  flexCopy: { flex: 1, gap: 3 },
  noCycleTag: { ...typography.caption, color: palette.gold, fontWeight: '800' },
  invalidLink: { ...typography.caption, color: palette.muted },
  cautionBox: { backgroundColor: palette.warningSoft, borderRadius: 12, padding: 12, gap: 4 },
  cautionTitle: { ...typography.label, color: palette.warning, fontWeight: '800' },
  cautionText: { ...typography.body, color: palette.warning },
});
