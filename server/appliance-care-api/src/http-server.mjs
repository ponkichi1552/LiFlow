import { createServer } from 'node:http';
import { persistAnalysisResult } from './persist-result.mjs';
import { randomUUID } from 'node:crypto';
import { analyzeApplianceCare, validateApplianceCareRequest } from './service.mjs';
import { analysisRequestKey, createAnalysisRunner } from './analysis-runner.mjs';
import { analyzeUploadedManual, decodeUploadedManual, inspectUploadedManual, MAX_MANUAL_BYTES } from './uploaded-manual.mjs';
import { PublicApiError } from './public-access.mjs';
import { SubscriptionError } from './subscription-service.mjs';

const MAX_BODY_BYTES = 8 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const JOB_RETENTION_MS = 10 * 60_000;
const MAX_JOBS = 100;
const STATUS_BY_ERROR = {
  INVALID_REQUEST: 400,
  SEARCH_FAILED: 502,
  MANUAL_NOT_FOUND: 422,
  MANUAL_FETCH_FAILED: 502,
  AI_ANALYSIS_FAILED: 502,
  INVALID_AI_OUTPUT: 502,
  PRODUCT_NOT_FOUND: 404,
  ANALYSIS_FAILED: 502,
  TEMPORARY_NETWORK_ERROR: 503,
  RATE_LIMITED: 429,
};

export function createApplianceCareHttpServer({ dependencies, aiConfigured = true, allowedOrigins = [], analysisLimits = {},
  publicAccess, subscriptionAccess = publicAccess?.subscriptions, billingOnly = false, createJobDependencies, manualUploadsOnly = Boolean(publicAccess) }) {
  if (billingOnly && !subscriptionAccess?.service) throw new Error('Billing-only mode requires verified subscription services');
  if (publicAccess && !manualUploadsOnly) throw new Error('Public AI requires uploaded manuals');
  if (process.env.NODE_ENV?.trim().toLowerCase() === 'production' && publicAccess?.mode !== 'firebase-firestore') {
    const error = new Error('Public user authentication and distributed usage limits are required before production deployment.');
    error.code = 'DEVELOPMENT_API_ONLY';
    throw error;
  }
  if (process.env.NODE_ENV?.trim().toLowerCase() === 'production' && !publicAccess?.securityReady && !billingOnly) {
    const error = new Error('Verified native app, device continuity and reinstall protection are required for paid AI.');
    error.code = 'DEVICE_SECURITY_NOT_CONFIGURED'; throw error;
  }
  if (process.env.NODE_ENV?.trim().toLowerCase() === 'production' && !subscriptionAccess?.service) {
    const error = new Error('Verified subscriptions are required before public deployment');
    error.code = 'SUBSCRIPTIONS_NOT_CONFIGURED'; throw error;
  }
  const requestsByAddress = new Map();
  const publicRequestsByAddress = new Map();
  const publicRequestsByUser = new Map();
  const jobsById = new Map();
  const jobsByRequest = new Map();
  const analyze = manualUploadsOnly ? analyzeUploadedManual : analyzeApplianceCare;
  const runner = createAnalysisRunner({ dependencies, analyze, ...analysisLimits });
  return createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (request, response) => {
    return handle(request, response).catch(error => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      const expected = error instanceof PublicApiError || error instanceof SubscriptionError;
      if (expected && error.status === 401) response.setHeader('www-authenticate', 'Bearer');
      rejectRequest(request, response, expected ? error.status : 503, { status: 'error',
        code: expected ? error.code : 'TEMPORARY_NETWORK_ERROR',
        message: expected ? error.message : '家電AIの受付を確認できませんでした。時間をおいてお試しください。',
        ...(expected ? error.details : {}) });
    });
  });
  async function handle(request, response) {
    setSecurityHeaders(response);
    const origin = request.headers.origin;
    const allowedOrigin = allowedOrigins.find(value => value === origin);
    if (origin && !allowedOrigin) {
      rejectRequest(request, response, 403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'この接続元は許可されていません。' } });
      return;
    }
    if (allowedOrigin) response.setHeader('access-control-allow-origin', allowedOrigin);

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': publicAccess ? 'content-type, authorization, x-idempotency-key' : 'content-type',
        'access-control-max-age': '600',
      });
      response.end();
      return;
    }

    let url;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      sendJson(response, 400, { status: 'error', code: 'INVALID_REQUEST', message: 'リクエストURLを確認してください。' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, publicAccess ? { status: 'ok' } : { status: 'ok', aiConfigured });
      return;
    }
    if (publicAccess && !consumeRateLimit(request.socket.remoteAddress ?? 'unknown', publicRequestsByAddress, Date.now(), 300)) {
      throw new PublicApiError(429, 'RATE_LIMITED', 'リクエストが多すぎます。少し待って再試行してください。');
    }
    if (subscriptionAccess && await subscriptionAccess.handle(request, response, url)) return;
    if (billingOnly) {
      sendJson(response, 503, { code: 'DEVICE_VERIFICATION_UNAVAILABLE', message: '家電AIは安全な端末確認の準備中です。購入・復元は利用できます。' }); return;
    }
    const principal = publicAccess ? await publicAccess.authenticate(request) : null;
    if (principal && !consumeRateLimit(principal.uid, publicRequestsByUser, Date.now(), 90)) {
      throw new PublicApiError(429, 'RATE_LIMITED', 'リクエストが多すぎます。少し待って再試行してください。');
    }
    if (principal && subscriptionAccess && publicAccess.subscriptions !== subscriptionAccess) await subscriptionAccess.service.assertActive(principal.uid);
    if (publicAccess && request.method === 'GET' && url.pathname === '/api/appliance-care/usage') {
      sendJson(response, 200, { usage: await publicAccess.store.usage(principal) }); return;
    }
    const jobStatusMatch = request.method === 'GET'
      ? url.pathname.match(/^\/api\/appliance-care\/jobs\/([0-9a-f-]{36}|[0-9a-f]{64})$/iu)
      : null;
    if (jobStatusMatch) {
      if (publicAccess) {
        const job = await publicAccess.store.read(principal, jobStatusMatch[1]);
        sendJson(response, job ? 200 : 404, job ?? { status: 'error', code: 'JOB_NOT_FOUND', message: 'この解析結果を確認できません。もう一度検索してください。' });
        return;
      }
      pruneJobs(jobsById);
      const job = jobsById.get(jobStatusMatch[1]);
      if (!job) {
        sendJson(response, 404, { status: 'error', code: 'TEMPORARY_NETWORK_ERROR', message: '解析状況を確認できません。もう一度検索してください。' });
        return;
      }
      sendJson(response, 200, {
        stage: job.stage,
        done: job.done,
        ...(!job.done ? { pollAfterMs: 2000 } : {}),
        ...(job.done && job.result ? { result: job.result } : {}),
      });
      return;
    }
    const isAnalyzeRequest = request.method === 'POST' && url.pathname === '/api/appliance-care/analyze';
    const isJobRequest = request.method === 'POST' && url.pathname === '/api/appliance-care/jobs';
    if (publicAccess && isAnalyzeRequest) {
      sendJson(response, 405, { status: 'error', code: 'INVALID_REQUEST', message: '家電AIは解析ジョブとして開始してください。' }); return;
    }
    if (!isAnalyzeRequest && !isJobRequest) {
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'API endpointが見つかりません。' } });
      return;
    }
    if (!consumeRateLimit(request.socket.remoteAddress ?? 'unknown', requestsByAddress)) {
      rejectRequest(request, response, 429, { status: 'error', code: 'RATE_LIMITED', message: '短時間のリクエスト上限に達しました。少し待って再試行してください。' });
      return;
    }
    const contentType = request.headers['content-type'] ?? '';
    if (!/^application\/json(?:\s*;|$)/iu.test(contentType.trim())) {
      rejectRequest(request, response, 415, { status: 'error', code: 'INVALID_REQUEST', message: 'Content-Typeはapplication/jsonにしてください。' });
      return;
    }

    let body;
    try {
      body = await readJsonBody(request, manualUploadsOnly ? Math.ceil(MAX_MANUAL_BYTES / 3) * 4 + 4096 : MAX_BODY_BYTES);
    } catch (error) {
      const tooLarge = error?.code === 'BODY_TOO_LARGE';
      rejectRequest(request, response, tooLarge ? 413 : 400, {
        status: 'error',
        code: 'INVALID_REQUEST',
        message: tooLarge ? 'リクエストが大きすぎます。' : 'JSON形式のリクエストを送ってください。',
      });
      return;
    }
    if (!validateApplianceCareRequest(body)) {
      sendJson(response, 400, { status: 'error', code: 'INVALID_REQUEST', message: 'メーカー名・製品名・型番を確認してください。' });
      return;
    }
    if (!aiConfigured) {
      sendJson(response, 503, { status: 'error', code: 'ANALYSIS_FAILED', message: 'AI解析サーバーが設定されていません。管理者に確認してください。' });
      return;
    }

    let manual;
    if (manualUploadsOnly) {
      manual = decodeUploadedManual(body.manual);
      await inspectUploadedManual(manual.bytes);
    }
    const analysisRequest = {
      manufacturer: body.manufacturer.trim(),
      productName: body.productName.trim(),
      modelNumber: body.modelNumber.trim(),
      ...(typeof body.category === 'string' ? { category: body.category.trim() } : {}),
      ...(manual ? { manual } : {}),
    };
    if (publicAccess) {
      const admission = await publicAccess.store.admit({ principal, requestKey: analysisRequestKey(analysisRequest),
        forceReanalysis: body.forceReanalysis === true, idempotencyKey: request.headers['x-idempotency-key'] });
      if (admission.created) {
        // Work starts only after the durable quota/job transaction commits. Duplicate sends never start another worker.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.max(1, admission.deadlineAt - Date.now()));
        timeout.unref();
        let progress = Promise.resolve();
        void Promise.resolve().then(() => analyze(analysisRequest,
          createJobDependencies ? createJobDependencies(controller.signal) : dependencies, stage => {
            progress = progress.then(() => publicAccess.store.progress?.(admission, stage)).catch(() => undefined);
          }))
          .catch(() => ({ status: 'error', code: 'ANALYSIS_FAILED', message: '解析を完了できませんでした。時間をおいてお試しください。' }))
          .then(async result => { await progress; await persistAnalysisResult(publicAccess.store, admission, result); })
          // A failed final write leaves the reservation intact. Never repeat the paid work to repair persistence.
          .catch(() => undefined).finally(() => clearTimeout(timeout));
      }
      sendJson(response, 202, { jobId: admission.jobId, usage: admission.usage }); return;
    }
    if (isJobRequest) {
      pruneJobs(jobsById);
      const key = analysisRequestKey(analysisRequest);
      const existingId = jobsByRequest.get(key);
      const existingJob = existingId ? jobsById.get(existingId) : undefined;
      if (existingJob && (!existingJob.done || (body.forceReanalysis !== true && existingJob.result?.status === 'verified'))) {
        sendJson(response, 202, { jobId: existingId });
        return;
      }
      if (jobsById.size >= MAX_JOBS) {
        sendJson(response, 429, { status: 'error', code: 'RATE_LIMITED', message: '解析状況の保存上限に達しました。しばらく待って再試行してください。' });
        return;
      }
      const jobId = randomUUID();
      const job = { stage: 'product_verification', done: false, result: undefined, expiresAt: Date.now() + JOB_RETENTION_MS };
      jobsById.set(jobId, job);
      jobsByRequest.set(key, jobId);
      for (const [requestKey, id] of jobsByRequest) { if (!jobsById.has(id)) jobsByRequest.delete(requestKey); }
      void runner.run(analysisRequest, (stage) => { job.stage = stage; }, { bypassCache: body.forceReanalysis === true })
        .then((result) => { job.result = result; job.done = true; job.expiresAt = Date.now() + JOB_RETENTION_MS; })
        .catch(() => {
          job.result = { status: 'error', code: 'ANALYSIS_FAILED', message: '解析を完了できませんでした。時間をおいて再試行してください。' };
          job.done = true;
          job.expiresAt = Date.now() + JOB_RETENTION_MS;
        });
      sendJson(response, 202, { jobId });
      return;
    }

    try {
      const result = await runner.run(analysisRequest, undefined, { bypassCache: body.forceReanalysis === true });
      const status = result.status === 'error' ? (STATUS_BY_ERROR[result.code] ?? 502) : 200;
      sendJson(response, status, result);
    } catch {
      sendJson(response, 502, { status: 'error', code: 'ANALYSIS_FAILED', message: '解析を完了できませんでした。時間をおいて再試行してください。' });
    }
  }
}

function pruneJobs(jobsById, now = Date.now()) {
  for (const [id, job] of jobsById) {
    if (job.done && job.expiresAt <= now) jobsById.delete(id);
  }
}

export function startApplianceCareHttpServer({
  dependencies,
  aiConfigured = true,
  host = process.env.HOST ?? '127.0.0.1',
  port = Number(process.env.PORT ?? 8787),
  allowedOrigins = (process.env.APPLIANCE_CARE_ALLOWED_ORIGINS ?? 'http://localhost:8081,http://127.0.0.1:8081,http://localhost:19006')
    .split(',').map((origin) => origin.trim()).filter(Boolean),
  analysisLimits = {
    maxConcurrent: serverLimit(process.env.APPLIANCE_CARE_MAX_CONCURRENT, 3, 10),
    maxPerHour: serverLimit(process.env.APPLIANCE_CARE_MAX_PER_HOUR, 20, 1000),
  },
  publicAccess,
  billingOnly = false,
  createJobDependencies,
  manualUploadsOnly,
} = {}) {
  if (!publicAccess && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    const error = new Error('Unauthenticated development APIs must bind to loopback only.');
    error.code = 'DEVELOPMENT_API_LOCALHOST_ONLY'; throw error;
  }
  const server = createApplianceCareHttpServer({ dependencies, aiConfigured, allowedOrigins, analysisLimits, publicAccess, billingOnly, createJobDependencies, manualUploadsOnly });
  server.listen(port, host);
  return server;
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > maxBytes) {
        if (tooLarge) return;
        tooLarge = true;
        chunks.length = 0;
        request.pause();
        const error = new Error('Request body too large'); error.code = 'BODY_TOO_LARGE'; reject(error);
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (tooLarge) {
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    request.on('error', () => reject(new Error('Request read failed')));
    request.once('aborted', () => reject(new Error('Request aborted')));
  });
}

function consumeRateLimit(address, requestsByAddress, now = Date.now(), limit = RATE_LIMIT) {
  const oldest = requestsByAddress.values().next().value;
  if (oldest && now - oldest.startedAt >= RATE_WINDOW_MS) {
    for (const [key, value] of requestsByAddress) { if (now - value.startedAt >= RATE_WINDOW_MS) requestsByAddress.delete(key); }
  }
  const existing = requestsByAddress.get(address);
  if (!existing || now - existing.startedAt >= RATE_WINDOW_MS) {
    if (!existing && requestsByAddress.size >= 10_000) return false;
    requestsByAddress.set(address, { startedAt: now, count: 1 });
    return true;
  }
  if (existing.count >= limit) return false;
  existing.count += 1;
  return true;
}

function serverLimit(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

function setSecurityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('referrer-policy', 'no-referrer');
}

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

/** Stop an unconsumed upload after its error has been flushed to the client. */
function rejectRequest(request, response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.setHeader('connection', 'close');
  response.once('finish', () => request.destroy());
  sendJson(response, status, value);
}
