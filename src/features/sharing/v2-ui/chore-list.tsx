import type { ReactElement } from 'react';
import { AppButton } from '../../../components/planner-ui';
import { PersonIcon, GroupIcon } from '../../../components/group-icon';
import { ChoreLibrary } from '../../chores/chore-library';
import type { V2GroupScreenModel } from '../v2/controller';
import { v2GuideChores, type PersonalGuideSource } from './chore-book';

export function V2ChoreList({ model, busy, onDetails, onAdd, header, personal, onOpen }: { model: V2GroupScreenModel; busy: boolean;
  personal?: PersonalGuideSource; onOpen?: (id: string, source: 'personal' | 'shared') => void; onDetails: (id: string) => void; onConfiguration: (id: string) => void; onAdd?: () => void; header?: ReactElement }) {
  return <ChoreLibrary chores={v2GuideChores(model, personal)} header={header} disabled={busy}
    accessory={chore => chore.id.startsWith('personal:') ? <PersonIcon size={20} /> : <GroupIcon size={25} />}
    onOpen={key => { const source = key.startsWith('personal:') ? 'personal' : 'shared'; const id = key.slice(key.indexOf(':') + 1); if (onOpen) onOpen(id, source); else onDetails(id); }}
    footer={onAdd ? <AppButton title="家事を追加" accessibilityLabel="新しい共有家事を追加" variant="secondary" disabled={busy} onPress={onAdd} /> : undefined} />;
}
