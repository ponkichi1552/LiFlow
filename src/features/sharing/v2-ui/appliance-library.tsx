import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { AccordionSection } from '../../../components/accordion-section';
import { AppButton, palette, typography } from '../../../components/planner-ui';
import { ApplianceLibrary, type ApplianceLibraryItem } from '../../appliance-care/appliance-library';
import type { Appliance } from '../../appliance-care/contracts';
import { applianceProductIdentity } from '../../appliance-care/product-identity';
import type { V2GroupScreenModel } from '../v2/controller';

export function V2ApplianceLibrary({ model, personal, busy, header, onOpen, onReview, onPersonal }: {
  model: V2GroupScreenModel; personal?: Appliance[]; busy: boolean; header?: ReactNode;
  onOpen?: (id: string) => void; onReview?: (id?: string, productName?: string) => void;
  onPersonal?: (id: string) => void;
}) {
  const [deletedOpen, setDeletedOpen] = useState(false);
  const rows = model.appliances?.rows ?? [];
  const common = new Set(rows.filter(row => !row.deleted && row.manufacturer && row.modelNumber).map(row => applianceProductIdentity(row.manufacturer, row.modelNumber)));
  const items: ApplianceLibraryItem[] = [
    ...(personal ?? []).filter(row => !common.has(applianceProductIdentity(row.manufacturer, row.modelNumber))).map(row => ({ ...row, source: 'personal' as const })),
    ...rows.filter(row => !row.deleted).map(row => ({ ...row, source: 'shared' as const })),
  ];
  return <ApplianceLibrary joined items={items} personalReady={Boolean(personal)} busy={busy} header={header}
    onOpen={(source, id) => source === 'personal' ? onPersonal?.(id) : onOpen?.(id)}
    onAdd={(_source, productName) => onReview?.(undefined, productName)}
    footer={rows.some(row => row.deleted) ? <AccordionSection title="削除した共有家電" expanded={deletedOpen} onToggle={() => setDeletedOpen(value => !value)}>
      {rows.filter(row => row.deleted).map(row => <View key={row.id}><Text style={[typography.caption, { color: palette.muted }]}>{row.displayName}</Text>
        <AppButton title={`「${row.displayName}」の復元内容を確認`} variant="quiet" disabled={busy} onPress={() => onOpen?.(row.id)} /></View>)}
    </AccordionSection> : undefined} />;
}
