import { useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SettingsSwitch as Switch } from '../../components/settings-switch';
import type { ChoreDefinition } from '../../domain/chores/types';
import { groupChores } from '../../domain/chores/chore-groups';
import { Chevron } from '../../components/chevron';
import { AppButton, palette, typography } from '../../components/planner-ui';

type ToggleChore = Pick<ChoreDefinition, 'id' | 'name' | 'category' | 'archived' | 'enabled'>;
export function ChoreToggleList({ chores, expanded, setExpanded, save, onOpen, retryRead, readOnly = false }: {
  chores: readonly ToggleChore[]; expanded: Set<string>; setExpanded: Dispatch<SetStateAction<Set<string>>>;
  save(ids: string[], enabled: boolean): Promise<void | { refreshed: boolean }>; onOpen(id: string): void;
  retryRead?: () => Promise<boolean>;
  readOnly?: boolean;
}) {
  const running = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState(new Map<string, boolean>());
  const toggle = async (rows: ToggleChore[], enabled: boolean) => {
    if (running.current || values.size) return;
    running.current = true; setBusy(true); setError(null); setValues(new Map(rows.map(row => [row.id, enabled])));
    let retain = false;
    try {
      const result = await save(rows.map(row => row.id), enabled);
      if (result?.refreshed === false) { retain = true; setError('保存済みですが、表示を更新できませんでした。再読込してください。'); }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '設定を保存できませんでした。'); }
    finally { running.current = false; setBusy(false); if (!retain) setValues(new Map()); }
  };
  return <View>{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {values.size && error && retryRead ? <AppButton title="家事の設定を再読込" variant="quiet" compact disabled={busy} onPress={() => {
      if (running.current) return; running.current = true; setBusy(true);
      void retryRead().then(ok => { if (ok) { setValues(new Map()); setError(null); } }).catch(() => undefined).finally(() => { running.current = false; setBusy(false); });
    }} /> : null}{groupChores(chores).map(([category, rows]) => {
    const open = expanded.has(category); const enabledCount = rows.filter(row => values.get(row.id) ?? row.enabled).length;
    const toggleCategory = () => setExpanded(current => { const next = new Set(current); if (open) next.delete(category); else next.add(category); return next; });
    return <View key={category} style={styles.group}>
      <View style={styles.heading}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${category}の家事を${open ? '閉じる' : '開く'}`} accessibilityState={{ expanded: open }}
          onPress={toggleCategory} style={styles.copy}>
          <Text style={styles.title}>{category}</Text>
        </Pressable>
        <Text style={styles.count}>{enabledCount}/{rows.length}</Text><Pressable accessibilityRole="button" accessibilityLabel={`${category}の見出しを${open ? '折りたたむ' : '展開'}`}
          style={styles.arrowTarget} onPress={toggleCategory}><Chevron direction={open ? 'up' : 'down'} /></Pressable>
      </View>
      {open ? rows.map(chore => <View key={chore.id} style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${chore.name}の個別設定`} onPress={() => onOpen(chore.id)} style={styles.copy}><Text style={styles.name}>{chore.name}</Text></Pressable>
        <Switch accessibilityLabel={`${chore.name}を有効にする`} value={values.get(chore.id) ?? chore.enabled} disabled={readOnly || busy || values.size > 0}
          onValueChange={value => void toggle([chore], value)} />
        <View aria-hidden style={styles.countSpacer} />
        <Pressable accessibilityRole="button" accessibilityLabel={`${chore.name}の設定を開く`} onPress={() => onOpen(chore.id)} style={styles.arrowTarget}><Chevron /></Pressable>
      </View>) : null}
    </View>;
  })}</View>;
}
const styles = StyleSheet.create({
  group: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 56 },
  copy: { flex: 1, minHeight: 48, justifyContent: 'center', paddingVertical: 8 },
  title: { ...typography.subheading, color: palette.ink, fontWeight: '700' },
  name: { ...typography.label, color: palette.ink, fontWeight: '600' },
  count: { ...typography.caption, color: palette.muted, minWidth: 32, textAlign: 'right', fontVariant: ['tabular-nums'] },
  arrowTarget: { minHeight: 44, minWidth: 28, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 56, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border, paddingLeft: 8 },
  countSpacer: { width: 32 },
  error: { ...typography.caption, color: palette.warning },
});
