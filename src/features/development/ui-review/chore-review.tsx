import { useRef, useState } from 'react';
import { Page } from '@/components/planner-ui';
import { PlannerLoadState } from '@/components/planner-load-state';
import { SettingsHeader } from '@/components/settings-header';
import { createPersonalChoreDefinitions } from '@/domain/chores/personal-catalog';
import { groupChores } from '@/domain/chores/chore-groups';
import { ChoreGuide } from '@/features/chores/chore-guide';
import { ChoreLibrary, ChoreLibraryPane, useChoreLibraryState } from '@/features/chores/chore-library';
import { TriviaArticleContent, TriviaLibrary, useTriviaLibraryState } from '@/features/chores/trivia-library';
import { ChoreToggleList } from '@/features/settings/chore-toggle-list';

export const choreReviewScenarios = [
  { id: 'library', label: '家事一覧・分類の展開' },
  { id: 'library-match', label: '家事を検索・説明を開く' },
  { id: 'library-no-match', label: '家事の検索結果なし' },
  { id: 'library-empty', label: '家事一覧・未登録' },
  { id: 'library-read-error', label: '家事一覧の読み込みに失敗' },
  { id: 'trivia', label: '豆知識・見出しと本文の検索' },
  { id: 'trivia-no-match', label: '豆知識の検索結果なし' },
  { id: 'trivia-missing', label: '豆知識が削除された' },
  { id: 'chore-toggles', label: '家事を有効・無効にする' },
  { id: 'chore-toggle-failure', label: 'チェックの保存に失敗' },
  { id: 'chore-toggle-refresh', label: '保存後の更新に失敗' },
  { id: 'chore-toggles-readonly', label: '編集権限がない共有家事設定' },
] as const;

const definitions = createPersonalChoreDefinitions('ui-review-chores');
const trivia = definitions.flatMap(chore => (chore.trivia ?? []).map((item, index) => ({ id: `${chore.id}:${item.id || index}`, chore, trivia: item })));

export function ChoreReview({ scenario, onExit }: { scenario: string; onExit(): void }) {
  const toggles = scenario.startsWith('chore-toggle');
  const startTrivia = scenario.startsWith('trivia');
  const [viewingTrivia, setViewingTrivia] = useState(startTrivia);
  const [guideId, setGuideId] = useState<string>();
  const [articleId, setArticleId] = useState(scenario === 'trivia-missing' ? 'deleted' : undefined);
  const [readFailed, setReadFailed] = useState(scenario === 'library-read-error');
  const [chores, setChores] = useState(scenario === 'library-empty' ? [] : definitions);
  const [expanded, setExpanded] = useState(() => new Set(groupChores(definitions).slice(0, 1).map(([category]) => category)));
  const saveAttempted = useRef(false);
  const pendingDisplay = useRef<{ changed: ReadonlySet<string>; enabled: boolean } | null>(null);
  const displayAttempts = useRef(0);
  const listState = useChoreLibraryState(scenario === 'library-match' ? '洗濯' : scenario === 'library-no-match' ? 'ハンダ付け' : '');
  const triviaState = useTriviaLibraryState(scenario === 'trivia-no-match' ? 'ハンダ付け' : '');
  const header = (title: string, back = onExit, backLabel = 'UI確認用データ一覧へ戻る') =>
    <SettingsHeader title={title} onBack={back} backAccessibilityLabel={backLabel} />;
  if (readFailed) return <PlannerLoadState header={header('家事一覧')} message="家事を読み込んでいます。" error="家事一覧を読み込めませんでした。"
    retry={async () => setReadFailed(false)} />;
  const openGuide = guideId ? chores.find(chore => chore.id === guideId) : undefined;
  const guide = openGuide ? <Page header={header(openGuide.name, () => setGuideId(undefined), '家事一覧に戻る')}>
    <ChoreGuide chore={openGuide} mode="balanced" />
  </Page> : null;
  const list = toggles ? <Page header={header('家事ごとの設定')}>
    <ChoreToggleList chores={chores} expanded={expanded} setExpanded={setExpanded} onOpen={setGuideId}
      readOnly={scenario === 'chore-toggles-readonly'} retryRead={async () => {
        const pending = pendingDisplay.current;
        if (!pending) return true;
        if (++displayAttempts.current === 1) return false;
        pendingDisplay.current = null;
        setChores(current => current.map(chore => pending.changed.has(chore.id) ? { ...chore, enabled: pending.enabled } : chore));
        return true;
      }} save={async (ids, enabled) => {
        const first = !saveAttempted.current;
        saveAttempted.current = true;
        if (first && scenario === 'chore-toggle-failure') throw new Error('設定を保存できませんでした。');
        const changed = new Set(ids);
        if (first && scenario === 'chore-toggle-refresh') { pendingDisplay.current = { changed, enabled }; return { refreshed: false }; }
        setChores(current => current.map(chore => changed.has(chore.id) ? { ...chore, enabled } : chore));
      }} />
  </Page> : <ChoreLibrary chores={chores} header={header('家事一覧')} state={listState} onOpen={setGuideId} triviaCount={trivia.length}
    onTrivia={chores.length ? () => setViewingTrivia(true) : undefined} />;
  const triviaList = <TriviaLibrary items={trivia} state={triviaState} onOpen={setArticleId}
    onBack={startTrivia ? onExit : () => setViewingTrivia(false)}
    backAccessibilityLabel={startTrivia ? 'UI確認用データ一覧へ戻る' : undefined} />;
  const closeArticle = scenario === 'trivia-missing' ? onExit : () => setArticleId(undefined);
  const article = articleId ? <TriviaArticleContent item={trivia.find(row => row.id === articleId)}
    header={header('豆知識', closeArticle, scenario === 'trivia-missing' ? 'UI確認用データ一覧へ戻る' : '豆知識一覧に戻る')} /> : null;
  return <ChoreLibraryPane library={list} detail={viewingTrivia ? <ChoreLibraryPane library={triviaList} detail={article} /> : guide} />;
}
