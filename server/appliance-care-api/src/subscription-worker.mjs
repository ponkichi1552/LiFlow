import { createFirebasePublicRuntime } from './firebase-public-runtime.mjs';

// Run as a scheduled, request-independent job with the same server-only credentials as the API.
// No public retry endpoint, purchase proof or authentication token is emitted.
try {
  const runtime = createFirebasePublicRuntime();
  if (!runtime.subscriptions) throw new Error('Subscriptions are not configured');
  await runtime.subscriptions.service.ready();
  const result = await runtime.subscriptions.service.retryAcknowledgements();
  process.stdout.write(JSON.stringify({ event: 'subscription_acknowledgement_batch', ...result }) + '\n');
  if (result.failed || result.overdue) process.exitCode = 1;
} catch {
  process.stderr.write(JSON.stringify({ event: 'subscription_acknowledgement_worker_failed' }) + '\n');
  process.exitCode = 1;
}
