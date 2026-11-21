import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Chevron } from '../../components/chevron';
import { palette, typography } from '../../components/planner-ui';
import type { AnalysisWorkSummary } from './analysis-work';

export function AnalysisWorkRows({ items, onOpen }: { items: AnalysisWorkSummary[]; onOpen: (item: AnalysisWorkSummary) => void }) {
  return items.length ? <View>{items.map(item => (
    <Pressable key={item.id} accessibilityRole="button" onPress={() => onOpen(item)} style={styles.row}>
      <View style={styles.labels}>
        <Text style={styles.title}>{item.state === 'pending' ? '解析中' : item.state === 'ready' ? '解析結果を確認' : '解析状況を確認'}</Text>
        {item.filename ? <Text style={styles.filename} numberOfLines={1}>{item.filename}</Text> : null}
      </View>
      <Chevron />
    </Pressable>
  ))}</View> : null;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, minHeight: 48, gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  labels: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...typography.control, color: palette.ink, fontWeight: '600' },
  filename: { ...typography.caption, color: palette.muted },
});
