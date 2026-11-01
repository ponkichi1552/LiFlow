import { usePreventRemove } from 'expo-router';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { ChoreBook } from '../../../components/chore-book';
import { ScreenHeading, palette, typography } from '../../../components/planner-ui';
import { SettingsAudience } from '../../../components/settings-audience';
import { AccordionSection } from '../../../components/accordion-section';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2GroupUiSession } from './screen-session';
import { V2SettingsDraftCache, type RetainedV2Draft } from './settings-draft-cache';
import { V2ConfigurationEditor } from './configuration-editor';
import { V2ChoreDetailsEditor } from './chore-details-editor';
import { V2DateRightsEditor } from './date-rights-editor';
import { choreInAudience, type ChoreAudienceSelection } from '../../chores/audience-selection';

/** The same continuous document as personal settings, with shared authority enforced by each editor. */
export function V2ChoreSettingsBook({ model, session, choreId, selection, groupName, onBack, onSaved, development = false }: {
  model: V2GroupScreenModel; session: V2GroupUiSession; choreId?: string; groupName: string; onBack(): void; onSaved(): Promise<void>;
  development?: boolean; selection?: ChoreAudienceSelection;
}) {
  const drafts = useMemo(() => new Map<string, RetainedV2Draft>(), []); const leaving = useRef(false);
  const allowRemoval = useRef(() => {});
  const [invalidId, setInvalidId] = useState<string>(); const [error, setError] = useState<string | null>(null);
  const leave = async (navigate: () => void, canNavigate = () => true) => {
    if (leaving.current) return; leaving.current = true; setError(null);
    try {
      for (const [key, draft] of drafts) if (!await draft.flush()) {
        setInvalidId(key.slice(key.indexOf(':') + 1)); setError('保存できていない入力があります。表示中の家事を確認してください。'); return;
      }
      if (!canNavigate()) { setError('所属グループが変わりました。設定画面を開き直してください。'); return; }
      allowRemoval.current(); navigate();
    } catch { setError('入力を保存できませんでした。内容を保持しています。もう一度お試しください。');
    } finally { leaving.current = false; }
  };
  const disablePrevention = usePreventRemove(true, ({ repeat }) => { void leave(repeat); });
  useLayoutEffect(() => { allowRemoval.current = disablePrevention; }, [disablePrevention]);
  const chores = model.plan.chores.filter(row => !row.archived).map(row => ({ ...row, householdId: model.plan.groupId }));
  const selectedId = selection ? choreInAudience(chores, selection) : choreId;
  return <V2SettingsDraftCache.Provider value={drafts}><ChoreBook title="家事ごとの設定" chores={chores}
    banner={development ? <Text style={[typography.caption, { color: palette.warning }]}>開発用・端末内プレビュー</Text> : undefined}
    selectedId={invalidId ?? selectedId} titleAccessory={visible => <SettingsAudience groupName={groupName} chore={visible} navigate={leave} />} onBack={() => void leave(onBack)}
    header={error ? <Text accessibilityRole="alert" style={[typography.caption, { color: palette.warning }]}>{error}</Text> : undefined}
    renderChore={chore => <SettingsChapter key={chore.id} choreId={chore.id} model={model} controller={session.controller} onSaved={onSaved} />} />
  </V2SettingsDraftCache.Provider>;
}

function SettingsChapter({ choreId, model: source, controller, onSaved }: { choreId: string; model: V2GroupScreenModel;
  controller: V2GroupController; onSaved(): Promise<void>;
}) {
  const [rightsOpen, setRightsOpen] = useState(false);
  // Every chapter uses the same authenticated read point; scrolling performs no new database reads.
  const model = { ...source, dateRights: source.choreDateRights?.find(row => row.choreId === choreId) };
  const chore = model.plan.chores.find(row => row.id === choreId);
  return <View style={{ gap: 14 }}><ScreenHeading title={chore?.name ?? '共有家事'} />
      <V2ConfigurationEditor model={model} choreId={choreId} controller={controller} onSaved={onSaved} />
      <V2ChoreDetailsEditor embedded model={model} choreId={choreId} controller={controller} onSaved={onSaved} onBack={() => {}} />
      {model.viewerUserId === model.adminUserId ? <AccordionSection title="日時変更の権限" expanded={rightsOpen} onToggle={() => setRightsOpen(value => !value)}>
        <V2DateRightsEditor embedded model={model} choreId={choreId} controller={controller} onSaved={onSaved} onBack={() => {}} />
      </AccordionSection> : null}
  </View>;
}
