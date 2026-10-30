import { Chevron } from '../../../components/chevron';
import { FormTextInput as TextInput } from '../../../components/form-text-input';
import { applianceCategoryLabel } from '@/features/appliance-care/categories';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette, typography } from '@/components/planner-ui';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePlannerData } from '@/hooks/use-planner-data';

export default function ManualScreen() {
  const { snapshot, loading, error, refresh } = usePlannerData();
  const [addDialogVisible, setAddDialogVisible] = useState(false);
  const [productName, setProductName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  if (loading || !snapshot) {
    return <PlannerLoadState title="家電" message="家電を読み込んでいます。" error={error} retry={refresh} />;
  }

  function continueToProductDetails() {
    const name = productName.trim();
    if (!name) {
      setAddError('製品名を入力してください。');
      return;
    }
    setAddDialogVisible(false);
    router.push({ pathname: '/manual/appliance-care', params: { productName: name, returnTo: '/manual' } });
  }

  return (
    <Page>
      <ScreenHeading title="家電の説明" description="登録した家電のお手入れ方法を確認できます。" />
      {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}

      <SectionHeading title="登録した家電" trailing={<Text style={styles.count}>{snapshot.appliances.length}台</Text>} />
      {snapshot.appliances.map((appliance) => (
        <Pressable
          key={appliance.id}
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/manual/appliances/[id]', params: { id: appliance.id, returnTo: '/manual' } })}
          style={({ pressed }) => [styles.applianceCard, pressed && styles.pressed]}>
          <View style={styles.applianceIcon}><Text style={styles.applianceIconText}>{appliance.category?.includes('洗濯') ? '▤' : '⌂'}</Text></View>
          <View style={styles.applianceCopy}>
            <Text style={styles.applianceName}>{appliance.displayName}</Text>
            <Text style={styles.applianceMeta}>{applianceCategoryLabel(appliance.category) ?? appliance.manufacturer} · {appliance.modelNumber}</Text>
          </View>
          <Chevron />
        </Pressable>
      ))}

      {snapshot.appliances.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>家電はまだ登録されていません</Text>
          <Text style={styles.emptyBody}>メーカー名・製品名・型番から公式説明書を調べ、お手入れ方法を保存できます。</Text>
        </Card>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="家電を追加"
        onPress={() => { setProductName(''); setAddError(null); setAddDialogVisible(true); }}
        style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
        <Text style={styles.addSymbol}>＋</Text>
      </Pressable>
      <Text style={styles.addCaption}>家電を追加</Text>

      <Modal
        visible={addDialogVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAddDialogVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>家電を追加</Text>
            <Text style={styles.modalHint}>製品名を入力してください。</Text>
            <TextInput
              autoFocus
              value={productName}
              onChangeText={(value) => { setProductName(value); setAddError(null); }}
              onSubmitEditing={() => continueToProductDetails()}
              returnKeyType="done"
              placeholder="例：V12 Detect Slim"
              placeholderTextColor={palette.muted}
              style={styles.modalInput}
              accessibilityLabel="家電の製品名"
              maxLength={120}
            />
            {addError ? <Text style={styles.error}>{addError}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable accessibilityRole="button" onPress={() => setAddDialogVisible(false)} style={styles.modalAction}>
                <Text style={styles.cancelText}>キャンセル</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => continueToProductDetails()} style={[styles.modalAction, styles.modalContinue]}>
                <Text style={styles.continueText}>次へ</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <View style={styles.secondaryActions}>
        <AppButton title="家事一覧・設定" onPress={() => router.push('/chores')} variant="secondary" />
        <AppButton title="実施履歴を見る" onPress={() => router.push('/history')} variant="quiet" compact />
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  count: { ...typography.caption, color: palette.muted },
  applianceCard: { minHeight: 92, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 16, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 16, paddingVertical: 14 },
  pressed: { opacity: 0.75 },
  applianceIcon: { width: 54, height: 54, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.accentSoft },
  applianceIconText: { color: palette.accent, fontSize: 25, fontWeight: '700' },
  applianceCopy: { flex: 1, gap: 5 },
  applianceName: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  applianceMeta: { ...typography.caption, color: palette.muted },
  chevron: { color: palette.muted, fontSize: 26, fontWeight: '300' },
  emptyCard: { paddingVertical: 24 },
  emptyTitle: { ...typography.body, color: palette.ink, fontWeight: '700' },
  emptyBody: { ...typography.body, color: palette.muted },
  addButton: { width: 54, height: 54, borderRadius: 18, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', backgroundColor: palette.accent, marginTop: 4 },
  addSymbol: { color: palette.accentInk, fontSize: 30, lineHeight: 34, fontWeight: '400' },
  addCaption: { ...typography.label, color: palette.accent, fontWeight: '700', textAlign: 'center', marginTop: -9 },
  secondaryActions: { gap: 3, marginTop: 7 },
  modalBackdrop: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(24, 31, 48, 0.36)' },
  modalCard: { borderRadius: 20, backgroundColor: palette.surface, padding: 20, gap: 12, shadowColor: '#182038', shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 12 },
  modalTitle: { ...typography.section, color: palette.ink, fontWeight: '800' },
  modalHint: { ...typography.caption, color: palette.muted },
  modalInput: { ...typography.body, minHeight: 54, borderRadius: 12, borderWidth: 1, borderColor: palette.border, paddingHorizontal: 13, color: palette.ink },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  modalAction: { minHeight: 42, minWidth: 94, paddingHorizontal: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.accentSoft },
  modalContinue: { backgroundColor: palette.accent },
  cancelText: { ...typography.label, color: palette.muted, fontWeight: '700' },
  continueText: { ...typography.label, color: palette.accentInk, fontWeight: '700' },
  error: { ...typography.label, color: palette.warning },
});
