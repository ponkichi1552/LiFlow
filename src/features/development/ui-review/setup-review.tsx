import { useRef, useState } from 'react';
import { Page } from '@/components/planner-ui';
import { SettingsHeader } from '@/components/settings-header';
import { createPersonalChoreDefinitions } from '@/domain/chores/personal-catalog';
import { FirstRunSetupForm, type FirstRunPage } from '@/features/onboarding/first-run-setup';
import { PersonalCapacitySettings } from '@/features/settings/personal-capacity-settings';
import type { PersonalCapacitySource } from '@/features/settings/personal-capacity-editor';
import { HomeReview } from './home-review';
import { homeReviewData } from './home-review-data';

export const setupReviewScenarios = [
  { id: 'first-chores', label: '家事を選ぶ', page: 'chores' },
  { id: 'first-rhythm', label: '休日・頻度を選ぶ', page: 'rhythm' },
  { id: 'first-capacity', label: '時間帯・上限を選ぶ', page: 'capacity' },
  { id: 'first-previous', label: '前回の実施を選ぶ', page: 'previous' },
  { id: 'first-weather', label: '予報の地域を検索する', page: 'weather' },
  { id: 'first-waste', label: '毎週・隔週・毎月のゴミ収集日', page: 'waste' },
  { id: 'first-save-error', label: '初回設定の保存に失敗', page: 'rhythm' },
  { id: 'first-reopen', label: '保存後にホームの読み込みに失敗', page: 'rhythm' },
] as const satisfies readonly { id: string; label: string; page: FirstRunPage }[];

export const rhythmReviewScenarios = [
  { id: 'rhythm-weekdays', label: '火・水が休日・特定日の上限を変更' },
  { id: 'rhythm-load-error', label: '日別設定を読み込めない' },
  { id: 'rhythm-save-error', label: '時間帯・上限の保存に失敗' },
] as const;

function onboardingSnapshot(configuredWaste: boolean) {
  const { snapshot } = homeReviewData('personal');
  const chores = createPersonalChoreDefinitions(snapshot.household.id).map((chore, index) => ({ ...chore, enabled: index < 6 }));
  const householdId = snapshot.household.id;
  return { ...snapshot, chores, settings: { ...snapshot.settings, restDays: [2, 3], weatherLocation: undefined }, wasteSchedules: configuredWaste ? [
    { id: 'qa-waste-week', householdId, label: '燃やすごみ', collectionWeekdays: [1, 4] as const },
    { id: 'qa-waste-fortnight', householdId, label: 'びん・缶', recurrence: 'biweekly' as const, collectionWeekdays: [3] as const, anchorDate: '2026-12-30' as const },
    { id: 'qa-waste-month', householdId, label: '古紙', recurrence: 'monthly' as const, collectionWeekdays: [], monthlyDay: 31 },
  ] : [] };
}

export function SetupReview({ scenario, onExit }: { scenario: string; onExit(): void }) {
  const [snapshot] = useState(() => onboardingSnapshot(scenario === 'first-waste'));
  const attempted = useRef({ save: false, open: false });
  const [done, setDone] = useState(false);
  if (done) return <HomeReview scenario="personal" onExit={onExit} />;
  const initialPage = setupReviewScenarios.find(row => row.id === scenario)?.page;
  return <FirstRunSetupForm snapshot={snapshot} initialPage={initialPage} referenceDate={snapshot.today} onExit={onExit} persist={async () => {
    if (scenario === 'first-save-error' && !attempted.current.save) {
      attempted.current.save = true;
      throw new Error('初回設定を保存できませんでした。');
    }
  }} onComplete={async () => {
    if (scenario === 'first-reopen' && !attempted.current.open) {
      attempted.current.open = true;
      throw new Error('ホームを読み込めませんでした。');
    }
    setDone(true);
  }} />;
}

const ignoreDraft = () => {};
export function RhythmReview({ scenario, onExit }: { scenario: string; onExit(): void }) {
  const [load] = useState(() => {
    let loadFailed = false, saveFailed = false;
    const source: PersonalCapacitySource = {
      initial: { allowedBands: [], dayOverrides: [{ date: '2026-12-28', holiday: true, maximumMinutes: 15 }],
        dayTypes: { workday: { maximumMinutes: 30 }, holiday: { maximumMinutes: 60 } } },
      async save(value) {
        if (scenario === 'rhythm-save-error' && !saveFailed) { saveFailed = true; throw new Error('日別設定を保存できませんでした。'); }
        source.initial = value;
      },
    };
    return async () => {
      if (scenario === 'rhythm-load-error' && !loadFailed) { loadFailed = true; throw new Error('日別設定を読み込めませんでした。'); }
      return source;
    };
  });
  return <PersonalCapacitySettings today="2026-12-26" restDays={[2, 3]} load={load} onDraftChange={ignoreDraft}>
    {content => <Page header={<SettingsHeader title="生活リズム" onBack={onExit} backAccessibilityLabel="UI確認用データ一覧へ戻る" />}>{content}</Page>}
  </PersonalCapacitySettings>;
}
