import { useEffect, useRef, type ReactNode } from 'react';
import { useNavigation } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Chevron } from '../../components/chevron';
import { AppButton, ScreenHeading, palette, typography } from '../../components/planner-ui';
import { usePlannerBorderStyles } from '../../components/use-planner-border-styles';
import { applianceDisplayName, appliancePrimaryName, applianceSecondaryLabel } from './display-name';

export type ApplianceAudience = 'personal' | 'shared';
export interface ApplianceLibraryItem {
  id: string; source: ApplianceAudience; displayName: string; manufacturer: string; modelNumber: string;
  category?: string; productName?: string; analysis?: { tasks?: readonly { name?: unknown }[] }; needsReview?: boolean;
}

/** One add flow. A joined group receives the same saved appliance, not another paid analysis. */
export function ApplianceLibrary({ items, joined = false, personalReady = true, busy = false, header, footer, onOpen, onAdd }: {
  items: ApplianceLibraryItem[]; joined?: boolean; personalReady?: boolean; busy?: boolean; header?: ReactNode; footer?: ReactNode;
  onOpen: (source: ApplianceAudience, id: string) => void; onAdd: (source: ApplianceAudience) => void;
}) {
  const styles = usePlannerBorderStyles(baseStyles);
  const continuing = useRef(false);
  const navigation = useNavigation();
  useEffect(() => navigation.addListener('focus', () => { continuing.current = false; }), [navigation]);
  return <View style={styles.root}>
    <FlatList data={items} keyExtractor={item => `${item.source}:${item.id}`} initialNumToRender={10}
      contentContainerStyle={styles.list}
      ListHeaderComponent={<View style={styles.heading}><View style={styles.titleRow}><ScreenHeading title="家電一覧" />
        {personalReady ? <Text style={styles.caption}>{items.length}台</Text> : null}</View>{header}
        {!personalReady ? <Text accessibilityLiveRegion="polite" style={styles.caption}>個人の家電は未取得です。</Text> : null}
      </View>}
      ListEmptyComponent={<View style={styles.empty}><Text style={styles.body}>{personalReady ? '家電は未登録です。' : '家電を読み込んでいます。'}</Text>
        <Text style={styles.caption}>取扱説明書PDFから追加できます。</Text></View>}
      renderItem={({ item }) => {
        const primary = appliancePrimaryName(item, item.displayName);
        const savedLabel = applianceSecondaryLabel(primary, [item.displayName]);
        const secondary = savedLabel || applianceSecondaryLabel(primary,
          item.productName ? [applianceDisplayName({ ...item, productName: item.productName })] : [item.manufacturer, item.modelNumber]);
        return <Pressable accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }}
        accessibilityLabel={`${primary === item.displayName ? primary : `${primary}、${item.displayName}`}のお手入れを開く（${item.source === 'shared' ? 'グループ' : '個人'}）`}
        accessibilityValue={item.needsReview ? { text: '確認が必要です' } : undefined}
        onPress={() => onOpen(item.source, item.id)} style={({ pressed }) => [styles.row, busy && styles.disabled, pressed && styles.pressed]}>
        <View pointerEvents="none" style={styles.copy}>
          <View style={styles.nameRow}><Text style={styles.name}>{primary}</Text>
            {item.needsReview ? <Text style={styles.warning}>確認が必要です</Text> : null}</View>
          {secondary ? <Text style={styles.caption}>{secondary}</Text> : null}</View>
        <Chevron />
      </Pressable>; }}
      ListFooterComponent={footer ? <>{footer}</> : undefined} />
    <View style={styles.add}>
      <AppButton title="家電を追加" disabled={busy} onPress={() => {
        if (continuing.current || busy) return;
        continuing.current = true;
        try { onAdd(joined ? 'shared' : 'personal'); }
        catch (cause) { continuing.current = false; throw cause; }
      }} />
    </View>
  </View>;
}

const baseStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background }, list: { paddingHorizontal: 18, paddingBottom: 24 }, heading: { gap: 12, paddingTop: 18, paddingBottom: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  copy: { flex: 1, minWidth: 0, gap: 4 }, name: { ...typography.control, fontWeight: '600', color: palette.ink },
  nameRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8 },
  body: { ...typography.body, color: palette.ink }, caption: { ...typography.caption, color: palette.muted, flexShrink: 1 }, warning: { ...typography.caption, color: palette.warning }, pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 }, empty: { gap: 6, paddingVertical: 12 },
  add: { padding: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
});
