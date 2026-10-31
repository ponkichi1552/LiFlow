import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { usePlannerData } from '@/hooks/use-planner-data';
import { useCallback, useState } from 'react';

import { AppButton, BackButton, Page, ScreenHeading } from '@/components/planner-ui';
import { ApplianceDetailContent } from '@/features/appliance-care/appliance-detail-content';
import type { ApplianceCareReviewContext } from '@/platform/storage/repository';
import { loadApplianceCareReviewContext } from '@/platform/storage/repository';

export default function ApplianceDetailScreen() {
  const params = useLocalSearchParams<{ id: string; returnTo?: string }>();
  const applianceId = Array.isArray(params.id) ? params.id[0] : params.id;
  const returnToParam = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = returnToParam === '/chores' ? '/chores' : returnToParam === '/manual' ? '/manual' : undefined;
  const { database } = usePlannerData({ personal: true });
  const [saved, setSaved] = useState<{ id: string; context: ApplianceCareReviewContext | null; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);

  useFocusEffect(useCallback(() => {
    let active = true;
    // Keep the existing list mounted on refocus, and ignore reads that finish after leaving.
    void loadApplianceCareReviewContext(database, applianceId).then((context) => {
      if (active) setSaved({ id: applianceId, context });
    }).catch(() => {
      if (active) setSaved((previous) => ({ id: applianceId,
        context: previous && previous.id === applianceId ? previous.context : null,
        error: '家電の情報を読み込めませんでした。',
      }));
    });
    return () => { active = false; };
  // The retry counter intentionally restarts the focused read after a failed request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applianceId, database, retry]));

  const goBack = () => returnTo ? router.dismissTo(returnTo) : router.back();
  if (!saved || saved.id !== applianceId) return <Page><BackButton accessibilityLabel="一覧へ戻る" onPress={goBack} /><ScreenHeading eyebrow="APPLIANCE CARE" title="家電の詳細" description="保存した公式資料とお手入れ項目を読み込んでいます。" /></Page>;
  if (!saved.context) return <Page><BackButton accessibilityLabel="一覧へ戻る" onPress={goBack} /><ScreenHeading eyebrow="APPLIANCE CARE" title={saved.error ?? '家電が見つかりません'} />{saved.error ? <AppButton title="再読み込み" onPress={() => setRetry((value) => value + 1)} /> : null}</Page>;

  return <ApplianceDetailContent context={saved.context} returnTo={returnTo} error={saved.error} />;
}
