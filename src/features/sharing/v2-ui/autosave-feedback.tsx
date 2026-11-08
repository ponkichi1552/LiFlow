import { Text } from 'react-native';
import { AppButton } from '../../../components/planner-ui';
import type { AutosaveState } from '../../settings/autosave-queue';
import { v2FormStyles as styles } from './form-controls';

/** A durable SQLite save and a failed view refresh have different retry actions. */
export function V2AutosaveFeedback({ status, refreshError, hasDraft, flush, discard, discardTitle, disabled = false, concise = false }: {
  status: AutosaveState; refreshError: string | null; hasDraft: boolean; flush: () => Promise<boolean>; discard: () => void; discardTitle: string; disabled?: boolean; concise?: boolean;
}) {
  return <>
    {status.phase !== 'saved' && (!concise || status.phase !== 'idle') ? <Text accessibilityRole={status.phase === 'error' ? 'alert' : undefined} accessibilityLiveRegion="polite" style={status.phase === 'error' ? styles.error : styles.caption}>
      {status.error ?? (['pending', 'saving'].includes(status.phase) ? '端末へ保存中…' : '変更は自動で保存されます。')}
    </Text> : null}
    {refreshError ? <Text accessibilityRole="alert" style={styles.error}>{refreshError}</Text> : null}
    {status.phase === 'error' ? <AppButton title="保存を再試行" variant="secondary" disabled={disabled} onPress={() => void flush()} /> : null}
    {hasDraft ? <AppButton title={discardTitle} variant="quiet" disabled={disabled} onPress={() => discard()} /> : null}
  </>;
}
