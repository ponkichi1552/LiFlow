import { useState, type ReactNode } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Text, View } from 'react-native';
import { AccordionSection } from '../../../components/accordion-section';
import { AppButton, palette, typography } from '../../../components/planner-ui';
import { ApplianceLibrary, type ApplianceLibraryItem } from '../../appliance-care/appliance-library';
import type { Appliance } from '../../appliance-care/contracts';
import { applianceProductIdentity } from '../../appliance-care/product-identity';
import type { V2GroupScreenModel } from '../v2/controller';
import { AnalysisWorkRows } from '../../appliance-care/analysis-work-rows';
import { useAnalysisWorkList } from '../../appliance-care/use-analysis-work';

export function V2ApplianceLibrary({ model, personal, personalDatabase, busy, header, onOpen, onReview, onPersonal, onPersonalReview }: {
  model: V2GroupScreenModel; personal?: Appliance[]; busy: boolean; header?: ReactNode;
  personalDatabase?: SQLiteDatabase;
  onOpen?: (id: string) => void; onReview?: (id?: string) => void;
  onPersonal?: (id: string) => void; onPersonalReview?: (id?: string) => void;
}) {
  const [deletedOpen, setDeletedOpen] = useState(false);
  const rows = model.appliances?.rows ?? [];
  const groupRows = rows.filter(row => !row.deleted);
  const common = new Set(groupRows.flatMap(row => row.manufacturer && row.modelNumber ? [applianceProductIdentity(row.manufacturer, row.modelNumber)] : []));
  const commonManuals = new Set(groupRows.flatMap(row => !row.modelNumber && row.manualDigest ? [row.manualDigest] : []));
  const items: ApplianceLibraryItem[] = [
    ...(personal ?? []).filter(row => row.modelNumber ? !common.has(applianceProductIdentity(row.manufacturer, row.modelNumber))
      : !commonManuals.has(row.analysis?.manualSource?.sha256 ?? '')).map(row => ({ ...row, source: 'personal' as const })),
    ...groupRows.map(row => ({ ...row, source: 'shared' as const })),
  ];
  const analysis = useAnalysisWorkList(personalDatabase, model.viewerUserId, model.plan.groupId);
  return <ApplianceLibrary joined items={items} personalReady={Boolean(personal)} busy={busy}
    header={<>{header}<AnalysisWorkRows items={analysis} onOpen={item => (item.groupId ? onReview : onPersonalReview)?.(item.applianceId)} /></>}
    onOpen={(source, id) => source === 'personal' ? onPersonal?.(id) : onOpen?.(id)}
    onAdd={() => onReview?.()}
    footer={rows.some(row => row.deleted) ? <AccordionSection title="削除した共有家電" expanded={deletedOpen} onToggle={() => setDeletedOpen(value => !value)}>
      {rows.filter(row => row.deleted).map(row => <View key={row.id}><Text style={[typography.caption, { color: palette.muted }]}>{row.displayName}</Text>
        <AppButton title={`「${row.displayName}」の復元内容を確認`} variant="quiet" disabled={busy} onPress={() => onOpen?.(row.id)} /></View>)}
    </AccordionSection> : undefined} />;
}
