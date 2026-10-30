import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { validateApplianceCareRequest } from './service.mjs';
import { analysisRequestKey, createAnalysisRunner } from './analysis-runner.mjs';

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

export function createApplianceCareHttpServer({ dependencies, aiConfigured = true, allowedOrigins = [], analysisLimits = {} }) {
  // Local limits and CORS do not authenticate a caller or bound distributed costs.
  // Keep this entry point development-only until a public gateway is implemented.
  if (process.env.NODE_ENV?.trim().toLowerCase() === 'production') {
    const error = new Error('The appliance-care API is development-only. Public user authentication and distributed usage limits are required before production deployment.');
    error.code = 'DEVELOPMENT_API_ONLY';
    throw error;
  }
  const requestsByAddress = new Map();
  const jobsById = new Map();
  const jobsByRequest = new Map();
  const runner = createAnalysisRunner({ dependencies, ...analysisLimits });
  return createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, async (request, response) => {
    setSecurityHeaders(response);
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      rejectRequest(request, response, 403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'この接続元は許可されていません。' } });
      return;
    }
    if (origin) response.setHeader('access-control-allow-origin', origin);

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
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
      sendJson(response, 200, { status: 'ok', aiConfigured });
      return;
    }
    const jobStatusMatch = request.method === 'GET'
      ? url.pathname.match(/^\/api\/appliance-care\/jobs\/([0-9a-f-]{36})$/iu)
      : null;
    if (jobStatusMatch) {
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
      body = await readJsonBody(request);
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

    const analysisRequest = {
      manufacturer: body.manufacturer.trim(),
      productName: body.productName.trim(),
      modelNumber: body.modelNumber.trim(),
      ...(typeof body.category === 'string' ? { category: body.category.trim() } : {}),
    };
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
  });
}

function pruneJobs(jobsById, now = Date.now()) {
  for (const [id, job] of jobsById) {
    if (job.done && job.expiresAt <= now) jobsById.delete(id);
  }
}

export function startApplianceCareHttpServer({
  dependencies,
  aiConfigured = true,
  host = process.env.HOST ?? '0.0.0.0',
  port = Number(process.env.PORT ?? 8787),
  allowedOrigins = (process.env.APPLIANCE_CARE_ALLOWED_ORIGINS ?? 'http://localhost:8081,http://127.0.0.1:8081,http://localhost:19006')
    .split(',').map((origin) => origin.trim()).filter(Boolean),
  analysisLimits = {
    maxConcurrent: serverLimit(process.env.APPLIANCE_CARE_MAX_CONCURRENT, 3, 10),
    maxPerHour: serverLimit(process.env.APPLIANCE_CARE_MAX_PER_HOUR, 20, 1000),
  },
} = {}) {
  const server = createApplianceCareHttpServer({ dependencies, aiConfigured, allowedOrigins, analysisLimits });
  server.listen(port, host);
  return server;
}

async function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
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

function consumeRateLimit(address, requestsByAddress, now = Date.now()) {
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
  if (existing.count >= RATE_LIMIT) return false;
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
