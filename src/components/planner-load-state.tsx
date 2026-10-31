import { useState } from 'react';
import { Text } from 'react-native';

import { AppButton, BackButton, Card, Page, ScreenHeading, palette } from '@/components/planner-ui';

export function PlannerLoadState({ title, message, error, retry, onBack }: {
  title: string;
  message: string;
  error: string | null;
  retry: () => Promise<void>;
  onBack?: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const retryLoad = async () => {
    setRetrying(true);
    try { await retry(); } finally { setRetrying(false); }
  };
  return (
    <Page startupReady={Boolean(error)} header={onBack ? <BackButton onPress={onBack} /> : undefined}>
      <ScreenHeading title={title} description={error ? 'データを読み込めませんでした。' : message} />
      {error ? (
        <Card>
          <Text style={{ color: palette.warning }}>{error}</Text>
          <AppButton title={retrying ? '再読み込み中…' : 'もう一度読み込む'} onPress={() => void retryLoad()} disabled={retrying} />
        </Card>
      ) : null}
    </Page>
  );
}
