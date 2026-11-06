import { startApplianceCareHttpServer } from './http-server.mjs';
import { OpenAIResponsesClient } from './openai-responses-client.mjs';

async function main() {
  const ai = new OpenAIResponsesClient({ maxOutputTokens: 16_384, maxToolCalls: 1 });
  const publicMode = process.env.APPLIANCE_CARE_MODE === 'public';
  // Keep the server-only Admin SDK out of the mobile dependency graph and local-only development path.
  const publicAccess = publicMode ? (await import('./firebase-public-runtime.mjs')).createFirebasePublicRuntime() : undefined;
  const billingOnly = Boolean(publicAccess && (!publicAccess.securityReady || !publicAccess.analysisQueueReady || !ai.isConfigured));
  if (publicAccess) {
    // Refuse the public listener if credentials, the project or quota-store permissions are not ready.
    await publicAccess.store.ready();
    await publicAccess.subscriptions.service.ready();
    void publicAccess.store.prune().catch(() => undefined);
  }
  const server = startApplianceCareHttpServer({
    dependencies: { analyzeUploaded: request => ai.createStructured(request) },
    manualUploadsOnly: true,
    aiConfigured: ai.isConfigured,
    publicAccess,
    billingOnly,
  });

  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  server.on('listening', () => {
    process.stdout.write('Appliance-care API listening on ' + host + ':' + port
      + ' (OpenAI configured: ' + String(ai.isConfigured) + ')\n');
  });
  server.on('error', () => {
    process.stderr.write('Appliance-care API failed to start. Check HOST and PORT.\n');
    process.exitCode = 1;
  });

  function shutdown() {
    server.close(() => process.exit(0));
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (publicAccess) {
    const cleanup = setInterval(() => { void publicAccess.store.prune().catch(() => undefined); }, 60 * 60_000);
    cleanup.unref();
    server.on('close', () => clearInterval(cleanup));
  }
}

void main().catch(() => {
  process.stderr.write('Appliance-care API startup refused. Check AI configuration, Firebase project, server credentials and quota-store permissions.\n');
  process.exitCode = 1;
});
