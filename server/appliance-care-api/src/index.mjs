import { startApplianceCareHttpServer } from './http-server.mjs';
import { OpenAIResponsesClient } from './openai-responses-client.mjs';

async function main() {
  const publicMode = process.env.APPLIANCE_CARE_MODE === 'public';
  const ai = publicMode ? undefined : new OpenAIResponsesClient({ maxToolCalls: 1 });
  // Keep the server-only Admin SDK out of the mobile dependency graph and local-only development path.
  const publicAccess = publicMode ? (await import('./firebase-public-runtime.mjs')).createFirebasePublicRuntime() : undefined;
  const billingOnly = Boolean(publicAccess && (!publicAccess.securityReady || !publicAccess.analysisQueueReady));
  if (publicAccess) {
    // Refuse the public listener if credentials, the project or quota-store permissions are not ready.
    await publicAccess.store.ready();
    await publicAccess.subscriptions.service.ready();
  }
  const server = startApplianceCareHttpServer({
    dependencies: ai ? { analyzeUploaded: request => ai.createStructured(request) } : {},
    manualUploadsOnly: true,
    aiConfigured: publicMode || ai?.isConfigured,
    publicAccess,
    billingOnly,
  });

  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  server.on('listening', () => {
    process.stdout.write('Appliance-care API listening on ' + host + ':' + port + '\n');
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
}

void main().catch(() => {
  process.stderr.write('Appliance-care API startup refused. Check AI configuration, Firebase project, server credentials and quota-store permissions.\n');
  process.exitCode = 1;
});
