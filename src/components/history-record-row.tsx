import type { ReactNode } from 'react';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { Chevron } from './chevron';
import { palette, typography } from './planner-ui';
import { plannerColorsForScheme } from './planner-theme';

/** The same compact record in personal and group history. Details never hide required actions. */
export function HistoryRecordRow({ name, time, status, performer, attention = false, children, details }: {
  name: string; time: string; status?: string; performer?: string; attention?: boolean;
  children?: ReactNode; details?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const colors = plannerColorsForScheme(useColorScheme());
  const summary = [status, performer].filter(Boolean).join(' · ');
  const copy = <><Text style={styles.name}>{name}</Text>
    {summary ? <Text style={[styles.status, attention && styles.attention]}>{summary}</Text> : null}</>;
  return <View style={[styles.record, { borderBottomColor: colors.border }]}>
    <View style={styles.row}>
      <Text style={styles.time}>{time}</Text>
      {details ? <Pressable accessibilityRole="button" accessibilityLabel={`${name}の記録の詳細`} accessibilityHint={[status, performer].filter(Boolean).join('。')}
        accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={styles.open}>
        <View style={styles.copy}>{copy}</View><Chevron direction={expanded ? 'up' : 'down'} />
      </Pressable> : <View style={styles.copy}>{copy}</View>}
    </View>
    {children ? <View style={styles.support}>{children}</View> : null}
    {expanded ? <View style={[styles.details, { backgroundColor: colors.elevated }]}>{details}</View> : null}
  </View>;
}

/** One quiet line replaces the former explanation and summary cards. */
export function HistoryOverview({ completedThisMonth }: { completedThisMonth: number }) {
  return <View style={styles.overview}><Text style={styles.status}>今月の完了</Text><Text style={styles.total}>{completedThisMonth}件</Text></View>;
}

const styles = StyleSheet.create({
  record: { borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  time: { ...typography.caption, color: palette.muted, width: 46, fontVariant: ['tabular-nums'] },
  open: { flex: 1, minWidth: 0, flexDirection: 'row', gap: 10, alignItems: 'center', minHeight: 44 },
  copy: { flex: 1, minWidth: 0, gap: 2 }, name: { ...typography.body, color: palette.ink, fontWeight: '600' },
  status: { ...typography.caption, color: palette.muted }, attention: { color: palette.warning },
  support: { paddingLeft: 56, gap: 8 },
  details: { borderRadius: 12, padding: 12, marginBottom: 8, gap: 6 },
  overview: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 4 },
  total: { ...typography.label, color: palette.ink, fontWeight: '600' },
});
