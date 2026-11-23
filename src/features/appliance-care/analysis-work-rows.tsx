import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Chevron } from '../../components/chevron';
import { palette, typography } from '../../components/planner-ui';
import type { AnalysisWorkSummary } from './analysis-work';

export function AnalysisWorkRows({ items, showScope = false, onOpen, onRetry }: {
  items: AnalysisWorkSummary[]; showScope?: boolean; onOpen: (item: AnalysisWorkSummary) => void; onRetry?: () => void;
}) {
  return items.length || onRetry ? <View>{items.map(item => {
    const filename = item.filename ?? '取扱説明書PDF';
    const state = item.state === 'pending' ? '結果待ち' : item.state === 'ready' ? '解析結果を確認' : '解析できませんでした';
    const status = showScope ? `${state} · ${item.groupId ? '共有' : '個人'}` : state;
    return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${filename}、${status}`} onPress={() => onOpen(item)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.labels}>
        <Text style={styles.title} numberOfLines={1}>{filename}</Text>
        <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>
      </View>
      <Chevron />
    </Pressable>;
  })}
    {onRetry ? <Pressable accessibilityRole="button" accessibilityLabel="解析状況を読み込めませんでした。再読み込み"
      onPress={onRetry} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <Text style={styles.retryMessage}>解析状況を読み込めませんでした</Text>
      <Text style={styles.retryAction}>再読み込み</Text>
    </Pressable> : null}
  </View> : null;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, minHeight: 48, gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  labels: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...typography.control, color: palette.ink, fontWeight: '600' },
  status: { ...typography.caption, color: palette.muted },
  retryMessage: { ...typography.caption, color: palette.muted, flex: 1 },
  retryAction: { ...typography.caption, color: palette.accent },
  pressed: { backgroundColor: palette.accentSoft },
});
