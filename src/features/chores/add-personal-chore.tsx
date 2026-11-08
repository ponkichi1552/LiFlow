import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { AppButton, Page, SectionHeading, typography, palette } from '../../components/planner-ui';
import { SettingsPanel } from '../../components/settings-controls';
import { usePersonalSettingsData } from '@/hooks/use-personal-settings-data';
import { addPersonalChore } from '../../platform/storage/repository';
import { customChoreInput } from '../../domain/chores/custom-chore';
import { ChoreAddHeader, CustomChoreFields } from './custom-chore-fields';
import { initialCustomChoreOptions, CustomChoreOptionsFields, CustomChoreStepsField, parsedCustomChoreOptions } from './custom-chore-options';

export function AddPersonalChoreScreen() {
  const data = usePersonalSettingsData();
  const [draft, setDraft] = useState({ name: '', interval: '', ...initialCustomChoreOptions }); const input = useRef(draft);
  const pending = useRef(false); const alive = useRef(true); const created = useRef<string | null>(null);
  const [busy, setBusy] = useState(false); const [savedId, setSavedId] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const edit = (patch: Partial<typeof draft>) => { if (pending.current || created.current) return; input.current = { ...input.current, ...patch }; setDraft(input.current); setError(null); };
  const open = (id: string) => router.replace({ pathname: '/settings/chore/[id]', params: { id, source: 'personal' } });
  const save = async () => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(null);
    try {
      if (!created.current) {
        const value = { ...customChoreInput(input.current.name, input.current.interval), ...parsedCustomChoreOptions(input.current) };
        const chore = await addPersonalChore(data.database, value); created.current = chore.id;
        if (alive.current) setSavedId(chore.id);
      }
      await data.refresh(); if (data.readError()) throw new Error('端末に追加済みです。もう一度開いてください。');
      if (alive.current) open(created.current);
    } catch (cause) { if (alive.current) setError(created.current ? '端末に追加済みです。もう一度開いてください。' : cause instanceof Error ? cause.message : '追加できませんでした。'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <Page keyboardAware header={<ChoreAddHeader onBack={() => router.back()} disabled={busy} />} contentStyle={{ paddingTop: 10 }}
    footer={<>{error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning, paddingBottom: 8 }]}>{error}</Text> : null}
      <AppButton title={savedId ? '追加済みの家事を開く' : '追加'} onPress={() => void save()} disabled={busy} /></>}>
    <SectionHeading title="必須" level="subsection" />
    <SettingsPanel><CustomChoreFields name={draft.name} interval={draft.interval} disabled={busy || Boolean(savedId)} onName={name => edit({ name })} onInterval={interval => edit({ interval })} /></SettingsPanel>
    <SectionHeading title="任意" level="subsection" />
    <SettingsPanel><CustomChoreOptionsFields value={draft} onChange={edit} disabled={busy || Boolean(savedId)} />
      <CustomChoreStepsField value={draft.steps} onChange={steps=>edit({steps})} disabled={busy || Boolean(savedId)} /></SettingsPanel>
  </Page>;
}
