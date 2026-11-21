import { ActivityIndicator, Text, View } from 'react-native';
import type { ApplianceCareUsage, UploadedManualInput } from './api-contracts';
import { ManualUploadInput } from './manual-upload-input';
import { ApplianceAiAccount } from '@/features/appliance-care/ai-account';
import { SettingsAction, SettingsGroup } from '../../components/settings-controls';
import { palette, typography } from '../../components/planner-ui';

/** Personal and shared registration both accept a PDF without a product-entry step. */
export function ManualAnalysisForm({ retained, filename, disabled, inputDisabled = false, working, picking, canAnalyze, reanalysis = false, shared = false, invalidManual = false, usage, onReady, onManual, onPickingChange, onAnalyze }: {
  retained?: boolean; disabled: boolean; inputDisabled?: boolean; working: boolean; canAnalyze: boolean; reanalysis?: boolean; shared?: boolean;
  filename?: string; picking?: boolean; onPickingChange?(picking: boolean): boolean | void;
  invalidManual?: boolean;
  usage?: ApplianceCareUsage; onReady(ready: boolean): void; onManual(manual: UploadedManualInput | undefined, filename?: string): void;
  onAnalyze(): void;
}) {
  return <View style={{ gap: 14 }}>
    <Text style={[typography.caption, { color: palette.muted }]}>PDFから製品情報とお手入れ方法を読み取ります。</Text>
    <SettingsGroup title="取扱説明書">
      <Text style={[typography.caption, { color: palette.muted }]}>解析するとPDFをAI提供元へ送信します。{shared ? '確認して保存したPDFと解析結果はグループに共有されます。' : 'PDFと解析結果は個人用に保存します。'}</Text>
      <ManualUploadInput retained={retained} filename={filename} disabled={working || inputDisabled} needsReplacement={invalidManual} onPickingChange={onPickingChange} onChange={onManual} />
    </SettingsGroup>
    <ApplianceAiAccount disabled={working} onReady={onReady} remainingOverride={usage?.remaining} />
    {!invalidManual ? <SettingsAction intent="primary" placement="page" compact={false} title={working ? '解析しています…' : reanalysis ? 'PDFを再解析' : 'PDFを解析'}
      disabled={disabled || !canAnalyze || working || picking} onPress={onAnalyze} /> : null}
    {working ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><ActivityIndicator color={palette.accent} />
      <Text accessibilityLiveRegion="polite" style={[typography.caption, { color: palette.muted, flex: 1 }]}>製品情報とお手入れ方法を解析しています</Text>
    </View> : null}
  </View>;
}
