import { ActivityIndicator, Text, View } from 'react-native';
import type { ApplianceCareUsage, UploadedManualInput } from './api-contracts';
import { ManualUploadInput } from './manual-upload-input';
import { ApplianceAiAccount } from '@/features/appliance-care/ai-account';
import { SettingsAction, SettingsGroup } from '../../components/settings-controls';
import { palette, typography } from '../../components/planner-ui';

/** Personal and shared registration both accept a PDF without a product-entry step. */
export function ManualAnalysisForm({ retained, disabled, inputDisabled = false, working, canAnalyze, reanalysis = false, shared = false, usage, onReady, onManual, onAnalyze, onCancel }: {
  retained?: UploadedManualInput; disabled: boolean; inputDisabled?: boolean; working: boolean; canAnalyze: boolean; reanalysis?: boolean; shared?: boolean;
  usage?: ApplianceCareUsage; onReady(ready: boolean): void; onManual(manual: UploadedManualInput | undefined): void;
  onAnalyze(): void; onCancel?(): void;
}) {
  return <View style={{ gap: 14 }}>
    <Text style={[typography.caption, { color: palette.muted }]}>PDFから製品情報とお手入れ方法を読み取ります。</Text>
    <SettingsGroup title="取扱説明書">
      <Text style={[typography.caption, { color: palette.muted }]}>解析するとPDFをAI提供元へ送信します。{shared ? '保存したPDFと解析結果はグループにも共有します。' : 'PDFと解析結果はアプリに保存します。'}</Text>
      <ManualUploadInput retained={retained} disabled={working || inputDisabled} onChange={onManual} />
    </SettingsGroup>
    <ApplianceAiAccount disabled={working} onReady={onReady} remainingOverride={usage?.remaining} />
    <SettingsAction intent="primary" placement="page" compact={false} title={working ? '解析しています…' : reanalysis ? 'PDFを再解析' : 'PDFを解析'}
      disabled={disabled || !canAnalyze || working} onPress={onAnalyze} />
    {working ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><ActivityIndicator color={palette.accent} />
      <Text accessibilityLiveRegion="polite" style={[typography.caption, { color: palette.muted, flex: 1 }]}>製品情報とお手入れ方法を解析しています</Text>
      {onCancel ? <SettingsAction placement="page" title="解析を中止" onPress={onCancel} /> : null}
    </View> : null}
  </View>;
}
