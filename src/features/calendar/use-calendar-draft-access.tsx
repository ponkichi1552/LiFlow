import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { CalendarEditorDraft } from '../../platform/storage/calendar-events';

export function canReadCalendarDraft(draft: CalendarEditorDraft, groupId?: string, ownerScope?: string) {
  return draft.audience !== 'group' || Boolean(ownerScope && draft.groupId === groupId && draft.ownerScope === ownerScope);
}

export function useCalendarDraftAccess(groupId?: string, ownerScope?: string) {
  const session = useMemo(() => ({ groupId, ownerScope }), [groupId, ownerScope]);
  const active = useRef<typeof session | null>(session);
  useLayoutEffect(() => {
    active.current = session;
    return () => { active.current = null; };
  }, [session]);
  return useCallback((draft: CalendarEditorDraft) => {
    if (active.current !== session || !canReadCalendarDraft(draft, session.groupId, session.ownerScope)) throw new Error('下書きを保存したアカウントとグループを確認してください。');
  }, [session]);
}
