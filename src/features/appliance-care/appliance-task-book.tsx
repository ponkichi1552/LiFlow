import { useCallback, useMemo, type ReactNode } from 'react';
import { ChoreBook } from '../../components/chore-book';
import type { ApplianceCareTaskDraft } from './contracts';

type TaskChapter = { id: string; name: string; category: string; task?: ApplianceCareTaskDraft; index: number };

/** Use the same virtual document, scrub preview and backward browsing as chore explanations. */
export function ApplianceTaskBook({ tasks, label, header, footer, onBack, renderTask, embedded = false, hasTabBar = false, backAccessibilityLabel, backDisabled = false, title = 'お手入れ方法', bottomPadding }: {
  tasks: readonly ApplianceCareTaskDraft[]; label: string; header?: ReactNode; footer?: ReactNode; onBack(): void;
  renderTask(task: ApplianceCareTaskDraft, index: number): ReactNode;
  embedded?: boolean; hasTabBar?: boolean; backAccessibilityLabel?: string; backDisabled?: boolean; title?: string;
  bottomPadding?: number;
}) {
  const hasFooter = Boolean(footer);
  const chapters = useMemo<TaskChapter[]>(() => [
    ...tasks.map((task, index) => ({ id: `task:${index}:${task.name}`, name: task.name, category: label, task, index })),
    ...(hasFooter ? [{ id: 'appliance-actions', name: '家電の操作', category: label, index: -1 }] : []),
  ], [tasks, label, hasFooter]);
  const groups = useMemo(() => [[label, chapters] as const], [label, chapters]);
  const renderChapter = useCallback((chapter: TaskChapter) => chapter.task ? renderTask(chapter.task, chapter.index) : null, [renderTask]);
  return <ChoreBook chores={chapters} chapterGroups={groups} title={title} header={header} footer={footer} onBack={onBack} renderChore={renderChapter}
    showCategory={false} showIndex={tasks.length > 1} embedded={embedded} hasTabBar={hasTabBar} cardChapters itemLabel="お手入れ" backAccessibilityLabel={backAccessibilityLabel} backDisabled={backDisabled} renderBatchSize={1} bottomPadding={bottomPadding} />;
}
