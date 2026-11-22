import { useState, type ReactNode } from 'react';
import { Text } from 'react-native';

import { AppButton, BackButton, Card, Page, ScreenHeading, palette, typography } from '@/components/planner-ui';

export function PlannerLoadState({ title, message, error, retry, retryTitle = 'もう一度読み込む', onBack, header, startupReady = Boolean(error) }: {
  title?: string;
  message: string;
  error: string | null;
  retry?: () => Promise<void>;
  retryTitle?: string;
  onBack?: () => void;
  header?: ReactNode;
  startupReady?: boolean;
}) {
  const [retrying, setRetrying] = useState(false);
  const retryLoad = async () => {
    setRetrying(true);
    try { await retry?.(); } finally { setRetrying(false); }
  };
  return (
    <Page startupReady={startupReady} header={header ?? (onBack ? <BackButton onPress={onBack} /> : undefined)}>
      {title ? <ScreenHeading title={title} description={error ? undefined : message} />
        : !error ? <Text style={{ ...typography.body, color: palette.muted }}>{message}</Text> : null}
      {error ? (
        <Card>
          <Text accessibilityRole="alert" style={{ color: palette.warning }}>{error}</Text>
          {retry ? <AppButton title={retrying ? '再読み込み中…' : retryTitle} onPress={() => void retryLoad()} disabled={retrying} /> : null}
        </Card>
      ) : null}
    </Page>
  );
}
