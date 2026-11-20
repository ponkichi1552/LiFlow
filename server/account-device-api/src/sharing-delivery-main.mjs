import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { inspectDeliveryReadiness, setDeliveryPolicyState, startSharedDeliveryWorker } from './sharing-delivery-worker.mjs';

try {
  const projectId = process.env.LIFLOW_FIREBASE_PROJECT_ID;
  const localEmulator = process.env.FIRESTORE_EMULATOR_HOST;
  const emulatorAllowed = process.env.NODE_ENV !== 'production' && projectId?.startsWith('demo-') && /^127\.0\.0\.1:\d+$/u.test(localEmulator ?? '');
  if (!projectId || !/^[a-z][a-z0-9-]{4,62}$/u.test(projectId)
    || Boolean(localEmulator) !== Boolean(emulatorAllowed) || projectId.startsWith('demo-') && !emulatorAllowed
    || [process.env.GCLOUD_PROJECT, process.env.GOOGLE_CLOUD_PROJECT].some(value => value && value !== projectId)) {
    throw new Error('Delivery Firestore target is invalid');
  }
  const [command, kind, scopeId, ...extra] = process.argv.slice(2);
  if (extra.length || (command && !['--status', '--enroll', '--enable', '--pause'].includes(command))
    || (!command || command === '--status') && (kind || scopeId)) throw new Error('Invalid delivery command');
  if (!command && process.env.LIFLOW_ENABLE_DELIVERY_ERASURE !== '1') throw new Error('Erasure process has not been enabled');
  const app = initializeApp({ projectId, credential: applicationDefault() }, 'liflow-sharing-delivery');
  const firestore = getFirestore(app);
  const report = value => process.stdout.write(JSON.stringify(value) + '\n');
  if (command) {
    try {
      report(command === '--status' ? await inspectDeliveryReadiness(firestore, projectId)
        : await setDeliveryPolicyState(firestore, { kind, scopeId, action: command.slice(2) }, projectId));
    } finally { await firestore.terminate(); }
  } else {
    const stop = startSharedDeliveryWorker(firestore, report, projectId);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { stop(); await firestore.terminate(); });
  }
} catch {
  process.stderr.write(JSON.stringify({ event: 'delivery_worker_command_refused' }) + '\n');
  process.exitCode = 1;
}
