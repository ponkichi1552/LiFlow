import { useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import type { ChoreDefinition } from '../../domain/chores/types';
import { groupChores } from '../../domain/chores/chore-groups';
import { choreFamilies, presentedChoreRecipe } from '../../domain/chores/chore-presentation';
import { personalChoreRecipe, planPersonalCatalogToggles } from '../../domain/chores/personal-catalog';
import { Chevron } from '../../components/chevron';
import { AppButton, palette, typography } from '../../components/planner-ui';
import { plannerColorsForScheme } from '../../components/planner-theme';
import { SettingsCheckbox } from '../../components/settings-checkbox';

type ToggleChore = Pick<ChoreDefinition, 'id' | 'name' | 'category' | 'archived' | 'enabled'>
  & Partial<Pick<ChoreDefinition, 'personalRecipeId' | 'applianceId' | 'applianceCareSource'>>;
export function ChoreToggleList({ chores, expanded, setExpanded, save, onOpen, retryRead, readOnly = false, personalSelection = false, onPendingChange }: {
  chores: readonly ToggleChore[]; expanded: Set<string>; setExpanded: Dispatch<SetStateAction<Set<string>>>;
  save(ids: string[], enabled: boolean): Promise<void | { refreshed: boolean }>; onOpen(id: string): void;
  retryRead?: () => Promise<boolean>;
  readOnly?: boolean;
  personalSelection?: boolean; onPendingChange?(pending: boolean): void;
}) {
  const colors = plannerColorsForScheme(useColorScheme());
  const groups = useMemo(() => groupChores(chores).map(([category, rows]) => ({ category, rows, families: choreFamilies(rows) })), [chores]);
  const [splitExpansion, setSplitExpansion] = useState(new Map<string, boolean>());
  const running = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState(new Map<string, boolean>());
  const toggle = async (rows: ToggleChore[], enabled: boolean) => {
    if (running.current || values.size) return;
    const selected = new Set(chores.filter(chore => chore.enabled).map(chore => chore.id));
    const changed = new Map(rows.map(row => [row.id, enabled]));
    try {
      if (personalSelection) {
        for (const row of rows) if (!personalChoreRecipe(row.id)) { if (enabled) selected.add(row.id); else selected.delete(row.id); }
        const next = new Set(planPersonalCatalogToggles([...selected], rows.map(row => row.id), enabled));
        for (const chore of chores) if (next.has(chore.id) !== chore.enabled) changed.set(chore.id, next.has(chore.id));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '設定を確認してください。'); return; }
    running.current = true; onPendingChange?.(true); setBusy(true); setError(null); setValues(changed);
    let retain = false;
    try {
      const result = await save(rows.map(row => row.id), enabled);
      if (result?.refreshed === false) { retain = true; setError('保存済みですが、表示を更新できませんでした。再読込してください。'); }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '設定を保存できませんでした。'); }
    finally { running.current = false; setBusy(false); if (!retain) setValues(new Map()); onPendingChange?.(retain); }
  };
  const isEnabled = (chore: ToggleChore) => values.get(chore.id) ?? chore.enabled;
  const renderRow = (chore: ToggleChore, nested = false) => <View key={chore.id} style={[styles.row, { borderTopColor: colors.border }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${chore.name}の個別設定`} onPress={() => onOpen(chore.id)} style={styles.copy}>
      <Text style={[styles.name, nested && styles.nestedName]}>{chore.name}</Text>
    </Pressable>
    <SettingsCheckbox accessibilityLabel={`${chore.name}を有効にする`} value={isEnabled(chore)} disabled={readOnly || busy || values.size > 0}
      onValueChange={value => void toggle([chore], value)} />
    <Pressable accessibilityRole="button" accessibilityLabel={`${chore.name}の設定を開く`} onPress={() => onOpen(chore.id)} style={styles.arrowTarget}><Chevron color={colors.accent} /></Pressable>
  </View>;
  return <View>{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {values.size && error && retryRead ? <AppButton title="家事の設定を再読込" variant="quiet" compact disabled={busy} onPress={() => {
      if (running.current) return; running.current = true; onPendingChange?.(true); setBusy(true);
      void retryRead().then(ok => { if (ok) { setValues(new Map()); setError(null); onPendingChange?.(false); } }).catch(() => undefined).finally(() => { running.current = false; setBusy(false); });
    }} /> : null}{groups.map(({ category, rows, families }) => {
    const open = expanded.has(category); const enabledCount = rows.filter(isEnabled).length;
    const toggleCategory = () => setExpanded(current => { const next = new Set(current); if (open) next.delete(category); else next.add(category); return next; });
    return <View key={category} style={[styles.group, { borderTopColor: colors.border }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${category}の家事を${open ? '閉じる' : '開く'}`} accessibilityState={{ expanded: open }}
        onPress={toggleCategory} style={styles.heading}><Text style={styles.title}>{category}</Text>
        <Text style={styles.count}>{enabledCount}/{rows.length}</Text><Chevron color={colors.accent} direction={open ? 'up' : 'down'} />
      </Pressable>
      {open ? families.map(({ chore, children }) => {
        const active = children.some(isEnabled);
        const splitOpen = splitExpansion.get(chore.id) ?? active;
        const divided = children.some(child => isEnabled(child) && presentedChoreRecipe(child)?.exclusiveWithParent);
        return <View key={chore.id} style={children.length && splitOpen ? styles.splitFamily : undefined}>{renderRow(chore)}{children.length ? <>
          <Pressable accessibilityRole="button" accessibilityLabel={`${chore.name}の細かな家事を${splitOpen ? '閉じる' : '開く'}`} accessibilityState={{ expanded: splitOpen }}
            onPress={() => setSplitExpansion(current => new Map(current).set(chore.id, !splitOpen))} style={styles.splitDisclosure}>
            <Text style={[styles.splitLabel, divided && { color: colors.accent }]}>{divided ? '分けて管理中' : '細かく設定'}</Text>
            <Chevron color={colors.muted} direction={splitOpen ? 'up' : 'down'} />
          </Pressable>
          {splitOpen ? <View style={[styles.children, { borderLeftColor: colors.border }]}>{children.map(child => renderRow(child, true))}</View> : null}
        </> : null}</View>;
      }) : null}
    </View>;
  })}</View>;
}
const styles = StyleSheet.create({
  group: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52 },
  copy: { flex: 1, minHeight: 48, justifyContent: 'center', paddingVertical: 8 },
  title: { ...typography.body, color: palette.ink, fontWeight: '600', flex: 1 },
  name: { ...typography.label, color: palette.ink, fontWeight: '600' },
  count: { ...typography.caption, color: palette.muted, minWidth: 32, textAlign: 'right', fontVariant: ['tabular-nums'] },
  arrowTarget: { minHeight: 44, minWidth: 36, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 52, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border, paddingLeft: 4 },
  splitDisclosure: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, alignSelf: 'flex-start', paddingHorizontal: 4 },
  splitLabel: { ...typography.caption, color: palette.muted },
  children: { marginLeft: 8, paddingLeft: 12, borderLeftWidth: 2 },
  splitFamily: { paddingBottom: 14 },
  nestedName: { fontWeight: '400' },
  error: { ...typography.caption, color: palette.warning },
});
