import { doc, onSnapshot } from 'firebase/firestore';
import type { SharingCloudContext } from './firestore-context';

/** Signal only: actual requests/grants are authenticated and validated by the managed metadata endpoint. */
export function createSharingAccountDevices({ firestore, userId, checkAccount }: SharingCloudContext) {
  return {
    watchAccountDeviceRestores(changed: () => void, failed: (error: unknown) => void): () => void {
      checkAccount(); let stopped = false;
      const stop = onSnapshot(doc(firestore, 'sharingUsers', userId, 'deviceRestoreSignals', 'current'), () => {
        if (stopped) return;
        try { checkAccount(); changed(); } catch (error) { failed(error); }
      }, error => { if (!stopped) failed(error); });
      return () => { stopped = true; stop(); };
    },
  };
}
