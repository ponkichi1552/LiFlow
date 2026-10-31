import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { AppButton, BackButton, Card, ScreenHeading } from '../../../components/planner-ui';
import type { V2GroupController } from '../v2/controller';
import { V2FormScrollView, V2TextField, v2FormStyles as styles } from './form-controls';
import { v2ChoreDetailCodecs } from './chore-detail-fields';

export function V2AddChore({ actions, busy, run, onCreated, onBack, header }: { actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>; onCreated: (id: string) => void; onBack: () => void; header?: ReactNode }) {
  const [draft, setDraft] = useState({ name: '', steps: '' }); const input = useRef(draft); const pending = useRef(false); const alive = useRef(true);
  const durable = useRef<string | null>(null); const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const edit = (patch: Partial<typeof draft>) => { if (pending.current || busy || durable.current) return; input.current = { ...input.current, ...patch }; setDraft(input.current); setError(null); };
  const create = async () => {
    if (pending.current || busy) return; pending.current = true; setError(null);
    try {
      if (durable.current) { if (alive.current) onCreated(durable.current); return; }
      const name = v2ChoreDetailCodecs.name.parse(input.current.name) as string;
      const steps = v2ChoreDetailCodecs.instructions.parse(input.current.steps) as string[]; let created: string | undefined;
      await run(async () => {
        const operations = await actions.addChore(name, steps); created = operations[0]?.entityId;
        if (created) { durable.current = created; if (alive.current) setCreatedId(created); }
      });
      if (created && alive.current) onCreated(created);
    } catch (cause) { if (alive.current) setError(durable.current ? '端末に追加済みです。もう一度開いてください。'
      : cause instanceof Error ? cause.message : '追加する内容を確認してください。'); }
    finally { pending.current = false; }
  };
  return <V2FormScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }} header={<BackButton onPress={() => { if (!pending.current) onBack(); }} disabled={busy} />}>{header}
    <ScreenHeading title="共有家事を追加" /><Text style={styles.caption}>家事名と手順をグループ全員に公開します。追加後、管理者が種類・周期を設定すると予定に入ります。</Text>
    <Card><V2TextField label="追加する共有家事の名前" value={draft.name} maxLength={500} editable={!busy && !createdId} onChangeText={(name) => edit({ name })} />
      <V2TextField label="追加する手順（1行に1手順）" value={draft.steps} multiline editable={!busy && !createdId} onChangeText={(steps) => edit({ steps })} />
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <AppButton title={createdId ? '追加済みの家事を開く' : 'この内容を共有家事に追加'} disabled={busy} onPress={() => void create()} />
    </Card>
  </V2FormScrollView>;
}
