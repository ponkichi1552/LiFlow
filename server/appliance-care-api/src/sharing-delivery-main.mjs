import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { startSharedDeliveryWorker } from './sharing-delivery-worker.mjs';

if (!getApps().length) initializeApp({ credential: applicationDefault() });
const stop = startSharedDeliveryWorker(getFirestore(), event => process.stdout.write(JSON.stringify(event) + '\n'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { stop(); await getFirestore().terminate(); });
