import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton } from '../../components/planner-ui';
import { V2Choices, V2TextField, v2FormStyles } from './v2-ui/form-controls';
import type { GroupKind } from './v2/model';

export function GroupCreationForm({ busy, onCreate }: {
  protocol: 2; busy: boolean; onCreate(name: string, kind?: GroupKind): Promise<boolean>;
}) {
  const [name, setName] = useState(''); const [kind, setKind] = useState<GroupKind | ''>('');
  const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const disabled = busy || submitting;
  const submit = async () => {
    if (inFlight.current || disabled || !name.trim() || !kind) return;
    inFlight.current = true; setSubmitting(true); setError(null);
    try {
      const created = await onCreate(name.trim(), kind || undefined);
      if (created && alive.current) { setName(''); setKind(''); }
    } catch { if (alive.current) setError('作成するアカウントと接続を確認してください。入力内容は保持しています。'); }
    finally { inFlight.current = false; if (alive.current) setSubmitting(false); }
  };
  return <View style={{ gap: 12 }}>
    <V2TextField label="グループ名" displayLabel={false} filled value={name} maxLength={100} onChangeText={setName} placeholder="グループ名（例：わが家）" editable={!disabled} />
    <>
      <V2Choices compact label="グループの種類" value={kind} choices={[{ value: 'family', label: '家族' }, { value: 'roommates', label: '同居人' }]}
        disabled={disabled} onChange={value => { if (value === 'family' || value === 'roommates') setKind(value); }} />
      {kind ? <Text style={v2FormStyles.caption}>{kind === 'family' ? '管理者が家事の日時を指定できます。' : '担当者の同意をもとに日時を決めます。'}</Text> : null}
    </>
    <Text style={v2FormStyles.caption}>共有する家事は、作成後に選べます。</Text>
    {error ? <Text accessibilityRole="alert" style={v2FormStyles.error}>{error}</Text> : null}
    <AppButton title="グループを作成" disabled={disabled || !name.trim() || !kind} onPress={submit} />
  </View>;
}
