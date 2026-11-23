import type { ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { ApplianceCareUsage, UploadedManualInput } from './api-contracts';
import { ManualUploadInput } from './manual-upload-input';
import { ApplianceAiAccount } from '@/features/appliance-care/ai-account';
import { SettingsAction, SettingsGroup } from '../../components/settings-controls';
import { palette, typography } from '../../components/planner-ui';

type ManualAnalysisControlsProps = {
  retained?: boolean; hasManual: boolean; disabled: boolean; inputDisabled?: boolean; phase?: 'preparing' | 'analyzing'; reviewing?: boolean;
  canAnalyze: boolean; reanalysis?: boolean; shared?: boolean;
  filename?: string; picking?: boolean; onPickingChange?(picking: boolean): boolean | void;
  invalidManual?: string;
  onManual(manual: UploadedManualInput | undefined, filename?: string): void;
  onAnalyze(): void;
};

/** Personal and shared registration both accept a PDF without a product-entry step. */
export function ManualAnalysisForm({ usage, onReady, ...props }: ManualAnalysisControlsProps & {
  usage?: ApplianceCareUsage; onReady(ready: boolean): void;
}) {
  return <ManualAnalysisControls {...props} renderAccount={visible =>
    <ApplianceAiAccount visible={visible} disabled={props.inputDisabled ?? false} onReady={onReady} usageOverride={usage} />} />;
}

export function ManualAnalysisControls({ retained, hasManual, filename, disabled, inputDisabled = false, phase, reviewing = false, picking, canAnalyze,
  reanalysis = false, shared = false, invalidManual, onManual, onPickingChange, onAnalyze, renderAccount }: ManualAnalysisControlsProps & {
  renderAccount?(visible: boolean): ReactNode;
}) {
  const hasDocument = hasManual || retained;
  const showAnalysis = Boolean(hasDocument && !phase && !invalidManual && !reviewing);
  const picker = phase ? <View style={{ gap: 8 }}>
    {filename ? <Text numberOfLines={2} style={[typography.body, { color: palette.ink }]}>{filename}</Text> : null}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <ActivityIndicator accessible={false} color={palette.accent} />
      <Text accessibilityLiveRegion="polite" style={[typography.control, { color: palette.ink, flex: 1 }]}>
        {phase === 'preparing' ? 'PDFを準備中…' : '解析中'}
      </Text>
    </View>
    {phase === 'analyzing' ? <Text style={[typography.caption, { color: palette.muted }]}>家電一覧で状況を確認できます。</Text> : null}
  </View> : <ManualUploadInput retained={retained} selected={hasManual} filename={filename} disabled={inputDisabled}
    needsReplacement={Boolean(invalidManual)} analysisError={invalidManual} onPickingChange={onPickingChange} onChange={onManual} />;

  return <View style={{ gap: 14 }}>
    {hasDocument || phase ? <SettingsGroup title="取扱説明書" compact>{picker}</SettingsGroup>
      : <View style={{ gap: 8 }}>
        <Text style={[typography.caption, { color: palette.muted }]}>説明書からお手入れ方法を登録します。</Text>
        {picker}
      </View>}
    {renderAccount?.(showAnalysis)}
    {showAnalysis && canAnalyze && !disabled ? <View style={{ gap: 8 }}>
      <Text style={[typography.caption, { color: palette.muted }]}>PDFをAI提供元へ送信します。{shared
        ? '確認して保存したPDFと解析結果はグループに共有されます。' : 'PDFと解析結果は個人用に保存します。'}</Text>
      <SettingsAction intent="primary" placement="page" compact={false} title={reanalysis ? 'PDFを再解析' : 'PDFを解析'}
        disabled={inputDisabled || picking} onPress={onAnalyze} />
    </View> : null}
  </View>;
}
