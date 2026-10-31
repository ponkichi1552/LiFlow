import { useRef, useState, type ReactNode } from 'react';
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Chevron } from '../../components/chevron';
import { FormTextInput } from '../../components/form-text-input';
import { GroupIcon, PersonIcon } from '../../components/group-icon';
import { AppButton, Card, ScreenHeading, SectionHeading, palette, typography } from '../../components/planner-ui';
import { applianceCategoryLabel } from './categories';

export type ApplianceAudience = 'personal' | 'shared';
export interface ApplianceLibraryItem {
  id: string; source: ApplianceAudience; displayName: string; manufacturer: string; modelNumber: string;
  category?: string; needsReview?: boolean;
}

/** One library and one add flow. Opening or adding retains the item's actual storage scope. */
export function ApplianceLibrary({ items, joined = false, addSources = ['personal'], personalReady = true, busy = false, header, footer, onOpen, onAdd }: {
  items: ApplianceLibraryItem[]; joined?: boolean; personalReady?: boolean; busy?: boolean; header?: ReactNode; footer?: ReactNode;
  addSources?: readonly ApplianceAudience[];
  onOpen: (source: ApplianceAudience, id: string) => void; onAdd: (source: ApplianceAudience, productName: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [adding, setAdding] = useState(false); const [name, setName] = useState('');
  const [audience, setAudience] = useState<ApplianceAudience>('personal'); const [error, setError] = useState<string | null>(null);
  const continuing = useRef(false);
  const mixed = joined && items.some(item => item.source === 'personal') && items.some(item => item.source === 'shared');
  const proceed = () => {
    if (continuing.current || busy) return;
    const productName = name.trim(); if (!productName) { setError('製品名を入力してください。'); return; }
    continuing.current = true; setAdding(false); onAdd(audience, productName);
  };
  return <View style={styles.root}>
    <FlatList data={items} keyExtractor={item => `${item.source}:${item.id}`} initialNumToRender={10}
      contentContainerStyle={[styles.list, { paddingBottom: Math.max(insets.bottom, 12) + 88 }]}
      ListHeaderComponent={<View style={styles.heading}><ScreenHeading title="家電" />{header}
        {!personalReady ? <Text accessibilityLiveRegion="polite" style={styles.caption}>個人の家電は未取得です。</Text> : null}
        <SectionHeading title="登録した家電" trailing={<Text style={styles.caption}>{items.length}台</Text>} /></View>}
      ListEmptyComponent={<Card><Text style={styles.body}>{personalReady ? '家電はまだ登録されていません。' : '家電を読み込んでいます。'}</Text>
        <Text style={styles.caption}>取扱説明書PDFから、お手入れ方法を保存できます。</Text></Card>}
      renderItem={({ item }) => <Pressable accessibilityRole="button" disabled={busy}
        accessibilityLabel={`${item.displayName}のお手入れを開く（${item.source === 'shared' ? 'グループ' : '個人'}）`}
        onPress={() => onOpen(item.source, item.id)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <View pointerEvents="none" style={styles.copy}><Text style={styles.name}>{item.displayName}</Text>
          <View style={styles.metadata}>{mixed || item.source === 'shared' ? item.source === 'shared' ? <GroupIcon size={22} /> : <PersonIcon size={18} /> : null}
            <Text style={[styles.caption, item.needsReview && styles.warning]}>{item.needsReview ? '確認が必要です' : [applianceCategoryLabel(item.category) ?? item.manufacturer, item.modelNumber].filter(Boolean).join(' · ')}</Text></View></View>
        <Chevron />
      </Pressable>}
      ListFooterComponent={footer ? <>{footer}</> : undefined} />
    <View pointerEvents="box-none" style={[styles.add, { bottom: Math.max(insets.bottom, 12) }]}>
      <AppButton title="家電を追加" disabled={busy || addSources.length === 0} onPress={() => { continuing.current = false; setName(''); setAudience(addSources[0]); setError(null); setAdding(true); }} />
    </View>
    <Modal visible={adding} transparent animationType="fade" onRequestClose={() => setAdding(false)}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <View style={styles.dialog}><Text style={styles.dialogTitle}>家電を追加</Text>
          <FormTextInput autoFocus accessibilityLabel="家電の製品名" value={name} maxLength={120} placeholder="例：V12 Detect Slim"
            placeholderTextColor={palette.muted} returnKeyType="done" onChangeText={value => { setName(value); setError(null); }} onSubmitEditing={proceed} style={styles.input} />
          {addSources.length > 1 ? <View style={styles.audiences}>{addSources.map(source => <Pressable key={source} accessibilityRole="radio"
            accessibilityLabel={source === 'personal' ? '個人用に追加' : 'グループ共通に追加'} accessibilityState={{ checked: audience === source }} onPress={() => setAudience(source)}
            style={[styles.audience, audience === source && styles.selected]}>{source === 'personal' ? <PersonIcon size={20} /> : <GroupIcon size={24} />}<Text style={styles.body}>{source === 'personal' ? '個人' : 'グループ共通'}</Text></Pressable>)}</View> : null}
          {error ? <Text accessibilityRole="alert" style={styles.warning}>{error}</Text> : null}
          <View style={styles.dialogActions}><AppButton title="キャンセル" compact variant="quiet" onPress={() => setAdding(false)} /><AppButton title="次へ" compact onPress={proceed} /></View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background }, list: { paddingHorizontal: 16 }, heading: { gap: 12, paddingTop: 12, paddingBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 10, borderWidth: 1, borderColor: palette.border, borderRadius: 14, backgroundColor: palette.surface },
  copy: { flex: 1, minWidth: 0, gap: 4 }, metadata: { flexDirection: 'row', alignItems: 'center', gap: 6 }, name: { ...typography.subheading, fontWeight: '600', color: palette.ink },
  body: { ...typography.body, color: palette.ink }, caption: { ...typography.caption, color: palette.muted, flexShrink: 1 }, warning: { ...typography.caption, color: palette.warning }, pressed: { opacity: 0.75 },
  add: { position: 'absolute', left: 20, right: 20 }, backdrop: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(24,31,48,0.4)' },
  dialog: { padding: 20, gap: 14, borderRadius: 18, backgroundColor: palette.surface }, dialogTitle: { ...typography.subheading, fontWeight: '700', color: palette.ink },
  input: { ...typography.body, minHeight: 50, borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 12, paddingHorizontal: 12, color: palette.ink },
  audiences: { flexDirection: 'row', gap: 8 }, audience: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: palette.border, borderRadius: 10 },
  selected: { borderColor: palette.accent, backgroundColor: palette.accentSoft }, dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
