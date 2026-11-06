import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { PUBLIC_API_POLICY, PublicApiError, publicJobId, publicKey, publicUsage, usagePeriods } from './public-access.mjs';
import { prepareAnalysisQueueInput, decodeAnalysisQueueInput, captureAnalysisQueueKeys } from './analysis-queue-input.mjs';

const interrupted = { status: 'error', code: 'ANALYSIS_INTERRUPTED',
  message: '解析が中断されました。受付済みの1回分は記録されています。時間をおいて再試行してください。' };

/** Server-only documents. All counters and the job reservation commit together before any paid work begins. */
export function createFirestoreUsageStore({ firestore, policy = PUBLIC_API_POLICY, now = Date.now, analysisQueueKeys }) {
  const queueKeys = captureAnalysisQueueKeys(analysisQueueKeys);
  for (const key of Object.keys(PUBLIC_API_POLICY)) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) throw new Error('Invalid public API policy');
  }
  const root = firestore.collection('applianceApi').doc('v1');
  const globalRef = root.collection('control').doc('global');
  const workerRef = root.collection('control').doc('analysisWorker');
  const dayRef = day => root.collection('dailyUsage').doc(day);
  const userRef = (uid, month) => root.collection('usage').doc(publicKey(JSON.stringify([uid, month])));
  const deviceRef = (deviceId, month) => root.collection('deviceUsage').doc(publicKey(JSON.stringify([deviceId, month])));
  const jobRef = id => root.collection('jobs').doc(id);
  const chunkRef = (id, index) => root.collection('analysisInputChunks').doc(`${id}.${index}`);
  // Minimal, immutable replay receipts outlive the PDF/result retention period.
  // An old retry must never turn into another paid request after its result expires.
  const admissionRef = id => root.collection('admissions').doc(id);
  const chargeRef = id => root.collection('chargeDecisions').doc(id);
  const stateRef = id => root.collection('quotaStates').doc(id);
  const immutableStates = new Map(); const terminalCharges = new Map();
  const admitting = new Map();
  function checkPrincipal(principal) {
    if (!principal || typeof principal.uid !== 'string' || !principal.uid || principal.anonymous !== false
      || !/^[a-f0-9]{64}$/u.test(principal.deviceId) || typeof principal.installationId !== 'string'
      || !/^[A-Za-z0-9_.:-]{16,200}$/u.test(principal.installationId)) {
      throw new PublicApiError(403, 'DEVICE_VERIFICATION_REQUIRED', '本人と端末の継続性を確認できないため解析できません。');
    }
  }
  function counter(doc) {
    if (!doc) return 0;
    if (!Number.isSafeInteger(doc.count) || doc.count < 0) throw new Error('Invalid stored usage counter');
    return doc.count;
  }
  async function quotaState(transaction, principal, account, device, at) {
    const periods = usagePeriods(at); const nodes = new Map(); const additions = new Map(); const evaluated = new Map();
    const remember = (cache, id, value) => { cache.set(id, value); while (cache.size > 4096) cache.delete(cache.keys().next().value); };
    const addNode = fields => { const node = { period: periods.month, ...fields }; const id = publicKey(JSON.stringify(node)); additions.set(id, node); nodes.set(id, node); return id; };
    async function node(id) {
      if (nodes.has(id)) return nodes.get(id);
      if (nodes.size >= 4096 || typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('Quota evidence limit');
      let data = immutableStates.get(id);
      if (!data) {
        const value = (await transaction.get(stateRef(id))).data();
        if (!value || value.period !== periods.month) throw new Error('Missing quota evidence');
        data = value.kind === 'fixed' ? { period: value.period, kind: value.kind, value: value.value }
          : value.kind === 'add' ? { period: value.period, kind: value.kind, base: value.base, charge: value.charge }
          : value.kind === 'max' ? { period: value.period, kind: value.kind, roots: value.roots } : null;
        if (!data || publicKey(JSON.stringify(data)) !== id) throw new Error('Corrupt quota evidence');
        remember(immutableStates, id, data);
      }
      if (data.period !== periods.month) throw new Error('Foreign quota period');
      nodes.set(id, data); return data;
    }
    const visiting = new Set();
    async function evaluate(id) {
      if (id === null) return 0;
      if (evaluated.has(id)) return evaluated.get(id);
      if (visiting.has(id)) throw new Error('Cyclic quota evidence'); visiting.add(id);
      const value = await node(id); let used;
      if (value.kind === 'fixed' && Number.isSafeInteger(value.value) && value.value >= 0 && value.value <= 100) used = value.value;
      else if (value.kind === 'max' && Array.isArray(value.roots) && value.roots.length === 2 && value.roots[0] < value.roots[1]) {
        used = Math.max(await evaluate(value.roots[0]), await evaluate(value.roots[1]));
      } else if (value.kind === 'add' && /^[a-f0-9]{64}$/u.test(value.charge)) {
        const decisionKey = periods.month + ':' + value.charge;
        let decision = terminalCharges.get(decisionKey);
        if (!decision) {
          decision = (await transaction.get(chargeRef(value.charge))).data();
          if (!decision || decision.period !== periods.month || !['pending', 'charged', 'refunded'].includes(decision.state)) throw new Error('Missing charge decision');
          if (decision.state !== 'pending') remember(terminalCharges, decisionKey, decision);
        }
        if (decision.period !== periods.month) throw new Error('Foreign charge period');
        used = await evaluate(value.base) + (decision.state === 'refunded' ? 0 : 1);
      } else throw new Error('Invalid quota evidence');
      if (!Number.isSafeInteger(used) || used < 0 || used > 100) throw new Error('Invalid derived quota');
      visiting.delete(id); evaluated.set(id, used); return used;
    }
    function rootFor(doc) {
      const count = counter(doc); if (count > 100) throw new Error('Invalid stored usage counter');
      if (!doc) return null;
      if (doc.rootId === null) { if (count !== 0) throw new Error('Invalid empty quota root'); return null; }
      if (doc.rootId === undefined) return count ? addNode({ kind: 'fixed', value: count }) : null;
      if (typeof doc.rootId !== 'string') throw new Error('Invalid quota root');
      return doc.rootId;
    }
    const accountRoot = rootFor(account); const deviceRoot = rootFor(device);
    const count = Math.max(await evaluate(accountRoot), await evaluate(deviceRoot));
    const contains = (root, target, seen = new Set()) => {
      if (root === target) return true; if (root === null || seen.has(root)) return false; seen.add(root);
      const value = nodes.get(root); return value?.kind === 'add' ? contains(value.base, target, seen)
        : value?.kind === 'max' ? value.roots.some(id => contains(id, target, seen)) : false;
    };
    let rootId = accountRoot;
    if (accountRoot === null || contains(deviceRoot, accountRoot)) rootId = deviceRoot;
    else if (deviceRoot !== null && !contains(accountRoot, deviceRoot)) rootId = addNode({ kind: 'max', roots: [accountRoot, deviceRoot].sort() });
    if (device && (typeof device.firstAccountUid !== 'string' || !device.firstAccountUid
      || typeof device.installationId !== 'string' || typeof device.lockedAfterReinstall !== 'boolean')) throw new Error('Invalid stored device binding');
    const lockedAfterReinstall = device?.lockedAfterReinstall === true || Boolean(device && device.installationId !== principal.installationId);
    const firstAccountUid = device?.firstAccountUid ?? principal.uid;
    return { count, rootId, additions, addNode, firstAccountUid, installationId: principal.installationId, lockedAfterReinstall,
      blocked: lockedAfterReinstall && firstAccountUid !== principal.uid,
      accountChanged: !account || account.rootId !== rootId || account.count !== count,
      deviceChanged: !device || device.rootId !== rootId || device.count !== count
        || device.installationId !== principal.installationId || device.lockedAfterReinstall !== lockedAfterReinstall,
      expiresAt: new Date(periods.monthResetAt + 90 * 86400_000) };
  }
  function writeQuota(transaction, principal, periods, state, chargeId) {
    const rootId = chargeId ? state.addNode({ kind: 'add', base: state.rootId, charge: chargeId }) : state.rootId;
    const count = state.count + (chargeId ? 1 : 0);
    for (const [id, node] of state.additions) transaction.set(stateRef(id), { ...node, expiresAt: state.expiresAt });
    if (state.accountChanged || chargeId) transaction.set(userRef(principal.uid, periods.month), { count, rootId, expiresAt: state.expiresAt });
    if (state.deviceChanged || chargeId) transaction.set(deviceRef(principal.deviceId, periods.month), { count, rootId,
      firstAccountUid: state.firstAccountUid, installationId: state.installationId,
      lockedAfterReinstall: state.lockedAfterReinstall, expiresAt: state.expiresAt });
  }
  const reinstallDenied = () => new PublicApiError(403, 'REINSTALL_ACCOUNT_LOCKED',
    '再インストール後の当月中の解析は、この端末で今月最初に紐づけたアカウントだけ利用できます。別のアカウントは翌月1日9時（日本時間）から利用できます。');
  async function synchronize(principal) {
    checkPrincipal(principal);
    const result = await firestore.runTransaction(async transaction => {
      const at = now(); const periods = usagePeriods(at);
      const [account, device] = await transaction.getAll(userRef(principal.uid, periods.month), deviceRef(principal.deviceId, periods.month));
      const state = await quotaState(transaction, principal, account.data(), device.data(), at);
      writeQuota(transaction, principal, periods, state);
      return { usage: publicUsage(state.count, at, policy), blocked: state.blocked };
    });
    // Commit the stricter counter and reinstall lock even for a denied account. A rejected operation must not erase that evidence.
    if (result.blocked) throw reinstallDenied();
    return result.usage;
  }
  async function readUsage(principal) {
    checkPrincipal(principal);
    const at = now(); const periods = usagePeriods(at);
    const [account, device] = await firestore.getAll(userRef(principal.uid, periods.month), deviceRef(principal.deviceId, periods.month));
    const state = await quotaState({ get: ref => ref.get() }, principal, account.data(), device.data(), at);
    // Informational reads never authorize paid work. Changed bindings, stricter
    // counters and refund evidence still take the authoritative transaction.
    if (state.blocked || state.accountChanged || state.deviceChanged || state.additions.size) return synchronize(principal);
    return publicUsage(state.count, at, policy);
  }
  function readable(job, at) {
    if (!job.done && job.deadlineAt <= at) return { stage: job.stage, done: true, result: interrupted, usage: job.usage };
    return { stage: job.stage, done: job.done, ...(job.done ? { result: job.result } : { pollAfterMs: 2000 }), usage: job.usage };
  }
  const store = {
    async ready() { await globalRef.get(); },
    async prune() {
      const at = new Date(now()); const batch = firestore.batch(); let count = 0;
      for (const collection of ['jobs', 'reuse', 'usage', 'dailyUsage', 'deviceUsage', 'chargeDecisions', 'quotaStates', 'analysisInputChunks']) {
        const expired = await root.collection(collection).where('expiresAt', '<=', at).limit(50).select('expiresAt').get();
        // A cache pointer may be renewed after the query; never delete a newer value from that stale result.
        for (const doc of expired.docs) { batch.delete(doc.ref, { lastUpdateTime: doc.updateTime }); count++; }
      }
      if (count) await batch.commit();
      return count;
    },
    async admit(input) {
      const principal = Object.freeze({ uid: input.principal?.uid, anonymous: input.principal?.anonymous,
        deviceId: input.principal?.deviceId, installationId: input.principal?.installationId });
      checkPrincipal(principal);
      const queuedInput = input.analysisRequest ? prepareAnalysisQueueInput(input.analysisRequest, input.requestKey, queueKeys,
        { owner: principal.uid, jobId: publicJobId(principal, input.idempotencyKey), requestDigest: publicKey(input.requestKey) }) : undefined;
      const captured = { principal, requestKey: input.requestKey, forceReanalysis: input.forceReanalysis === true, idempotencyKey: input.idempotencyKey,
        ...(queuedInput ? { queuedInput } : {}) };
      const key = publicKey(JSON.stringify({ principal, requestKey: captured.requestKey, forceReanalysis: captured.forceReanalysis, idempotencyKey: captured.idempotencyKey }));
      const existing = admitting.get(key);
      if (existing) { const receipt = await existing; return { jobId: receipt.jobId, created: false, usage: receipt.usage }; }
      if (admitting.size >= 256) throw new PublicApiError(429, 'RATE_LIMITED', '受付が混み合っています。少し待ってください。');
      const pending = store.reserve(captured); admitting.set(key, pending);
      try { return await pending; } finally { if (admitting.get(key) === pending) admitting.delete(key); }
    },
    async reserve({ principal, requestKey, forceReanalysis, idempotencyKey, queuedInput }) {
      checkPrincipal(principal);
      // Identity and request data are copied by the HTTP boundary before this asynchronous transaction.
      const requestDigest = publicKey(JSON.stringify([requestKey, forceReanalysis]));
      const admission = await firestore.runTransaction(async transaction => {
        const at = now(); const periods = usagePeriods(at);
        const id = publicJobId(principal, idempotencyKey); const ref = jobRef(id);
        const reuseRef = root.collection('reuse').doc(publicKey(JSON.stringify([principal.uid, requestKey])));
        const [jobDoc, globalDoc, userDoc, dailyDoc, reuseDoc, deviceDoc, chargeDoc, admissionDoc, workerDoc] = await transaction.getAll(ref, globalRef,
          userRef(principal.uid, periods.month), dayRef(periods.day), reuseRef, deviceRef(principal.deviceId, periods.month), chargeRef(id), admissionRef(id), workerRef);
        const state = await quotaState(transaction, principal, userDoc.data(), deviceDoc.data(), at);
        const job = jobDoc.data();
        if (state.blocked) { writeQuota(transaction, principal, periods, state); return { denied: reinstallDenied() }; }
        const receipt = admissionDoc.data();
        if (receipt) {
          if (receipt.owner !== principal.uid || receipt.requestDigest !== requestDigest || !/^[a-f0-9]{64}$/u.test(receipt.jobId)) {
            throw new PublicApiError(409, 'REQUEST_CONFLICT', '同じ受付IDで異なる解析は開始できません。');
          }
          const jobRequestDigest = receipt.jobRequestDigest ?? receipt.requestDigest;
          if (!/^[a-f0-9]{64}$/u.test(jobRequestDigest)) throw new Error('Invalid admission receipt');
          const previous = receipt.jobId === id ? job : (await transaction.get(jobRef(receipt.jobId))).data();
          writeQuota(transaction, principal, periods, state);
          if (!previous || previous.owner !== principal.uid || previous.requestDigest !== jobRequestDigest || previous.expiresAt.toMillis() <= at) {
            return { denied: new PublicApiError(409, 'REQUEST_CONFLICT', 'この受付IDの結果保存期間は終了しました。新しい操作としてやり直してください。') };
          }
          return { jobId: receipt.jobId, created: false, usage: publicUsage(state.count, at, policy) };
        }
        if (job) {
          if (job.owner !== principal.uid || job.requestDigest !== requestDigest) throw new PublicApiError(409, 'REQUEST_CONFLICT', '同じ受付IDで異なる解析は開始できません。');
          // A missing result is never transparently re-run after a crash: it may already have incurred cost.
          transaction.create(admissionRef(id), { owner: principal.uid, requestDigest, jobRequestDigest: requestDigest, jobId: id });
          writeQuota(transaction, principal, periods, state);
          return { jobId: id, created: false, usage: publicUsage(state.count, at, policy) };
        }
        if (chargeDoc.exists) { writeQuota(transaction, principal, periods, state); return { denied: new PublicApiError(409, 'REQUEST_CONFLICT', 'この受付IDの結果保存期間は終了しました。新しい操作としてやり直してください。') }; }
        const reusedId = reuseDoc.data()?.jobId;
        if (!forceReanalysis && reusedId) {
          const previous = (await transaction.get(jobRef(reusedId))).data();
          if (previous && previous.owner === principal.uid && previous.expiresAt.toMillis() > at
            && (!previous.done && previous.deadlineAt > at || previous.done && previous.result.status === 'verified')) {
            transaction.create(admissionRef(id), { owner: principal.uid, requestDigest, jobRequestDigest: previous.requestDigest, jobId: reusedId });
            writeQuota(transaction, principal, periods, state);
            return { jobId: reusedId, created: false, usage: publicUsage(state.count, at, policy) };
          }
        }
        if (queuedInput) {
          const heartbeat = workerDoc.data();
          if (!Number.isSafeInteger(heartbeat?.seenAt) || heartbeat.readyUntil !== heartbeat.seenAt + 90_000
            || heartbeat.seenAt > at + 30_000 || heartbeat.readyUntil <= at) {
            throw new PublicApiError(503, 'ANALYSIS_WORKER_UNAVAILABLE', '解析の準備ができていません。時間をおいてお試しください。');
          }
        }
        const global = globalDoc.data() ?? {};
        const active = (global.active ?? []).filter(item => item.deadlineAt > at);
        const count = state.count;
        const dayCount = counter(dailyDoc.data());
        const denied = error => { writeQuota(transaction, principal, periods, state); return { denied: error }; };
        if (count >= policy.monthlyLimit) return denied(new PublicApiError(429, 'MONTHLY_LIMIT_REACHED',
          `今月の家電AIは${policy.monthlyLimit}回までです。次の受付は毎月1日9時（日本時間）からです。`, { usage: publicUsage(count, at, policy) }));
        if (dayCount >= policy.dailyGlobalLimit) return denied(new PublicApiError(429, 'SERVICE_LIMIT_REACHED',
          '本日の家電AIの受付上限に達しました。翌日9時（日本時間）以降にお試しください。',
          { retryAt: new Date(periods.dayResetAt).toISOString() }));
        if (active.length >= policy.maxConcurrent || active.some(item => item.owner === principal.uid || item.deviceId === principal.deviceId)) {
          return denied(new PublicApiError(429, 'RATE_LIMITED', '解析が混み合っています。実行中の解析が終わってからお試しください。'));
        }
        const runId = randomUUID(); const deadlineAt = at + policy.jobTimeoutMs; const usage = publicUsage(count + 1, at, policy);
        writeQuota(transaction, principal, periods, state, id);
        transaction.create(admissionRef(id), { owner: principal.uid, requestDigest, jobRequestDigest: requestDigest, jobId: id });
        transaction.create(chargeRef(id), { period: periods.month, state: 'pending', deadlineAt, expiresAt: state.expiresAt });
        // Separate day documents prevent clock skew between instances from resetting an earlier day's counter.
        transaction.set(dayRef(periods.day), { count: dayCount + 1, expiresAt: new Date(periods.dayResetAt + 90 * 86400_000) });
        transaction.set(globalRef, { active: [...active, { jobId: id, owner: principal.uid, deviceId: principal.deviceId, runId, deadlineAt }] });
        transaction.set(reuseRef, { jobId: id, expiresAt: new Date(at + policy.retentionMs) });
        transaction.create(ref, { owner: principal.uid, requestDigest, runId, stage: 'product_verification', done: false,
          createdAt: at, deadlineAt, usage, expiresAt: new Date(at + policy.retentionMs),
          ...(queuedInput ? { queueVersion: 1, executionState: 'queued', inputManifest: queuedInput.manifest, inputRequestKey: publicKey(requestKey) } : {}) });
        if (queuedInput) for (const [index, bytes] of queuedInput.chunks.entries()) transaction.create(chunkRef(id, index), {
          jobId: id, index, runId, bytes, expiresAt: new Date(deadlineAt) });
        return { jobId: id, created: true, runId, deadlineAt, usage };
      });
      if (admission.denied) throw admission.denied;
      return admission;
    },
    async read(principal, id) {
      checkPrincipal(principal);
      if (!/^[a-f0-9]{64}$/u.test(id)) return null;
      const job = (await jobRef(id).get()).data(); const at = now();
      // Identical response for absent jobs, another user and expired results.
      if (!job || job.owner !== principal.uid || job.expiresAt.toMillis() <= at) return null;
      const output = readable(job, at);
      output.usage = await readUsage(principal);
      return output;
    },
    async usage(principal) { return synchronize(principal); },
    /** A separate request-independent worker owns these server-only operations. */
    async heartbeatAnalysisWorker() {
      const at = now(); if (!Number.isSafeInteger(at)) throw new Error('Invalid worker clock');
      await firestore.runTransaction(async transaction => { transaction.set(workerRef, { seenAt: at, readyUntil: at + 90_000 }); });
    },
    async listAnalysisWork(limit = 3) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid worker limit');
      const work = new Map();
      for (const state of ['resultReady', 'queued', 'preparing', 'executing']) {
        const snapshot = await root.collection('jobs').where('executionState', '==', state).limit(Math.max(limit, policy.maxConcurrent))
          .select('executionState', 'deadlineAt', 'claimExpiresAt', 'queueVersion', 'done').get();
        for (const doc of snapshot.docs) {
          const job = doc.data();
          if (job.queueVersion === 1 && !job.done && (state !== 'executing' || job.deadlineAt <= now())
            && (state !== 'preparing' || job.claimExpiresAt <= now())) work.set(doc.id, doc.id);
        }
      }
      return [...work.values()].slice(0, limit);
    },
    async claimAnalysis(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid analysis job');
      return firestore.runTransaction(async transaction => {
        const ref = jobRef(id); const job = (await transaction.get(ref)).data(); const at = now();
        if (!job || job.queueVersion !== 1 || job.done) return null;
        const admission = { jobId: id, runId: job.runId, deadlineAt: job.deadlineAt };
        if (job.executionState === 'resultReady') return { admission, result: job.result };
        if (job.deadlineAt <= at && ['queued', 'preparing', 'executing'].includes(job.executionState)) {
          transaction.update(ref, { executionState: 'resultReady', result: interrupted, resultReceivedAt: at });
          return { admission, result: interrupted };
        }
        if (job.executionState !== 'queued' && !(job.executionState === 'preparing' && job.claimExpiresAt <= at)) return null;
        // Input preparation can be leased safely; the separate start transition
        // fences this claim immediately before the first possible paid request.
        const claimId = randomUUID();
        transaction.update(ref, { executionState: 'preparing', claimId, claimExpiresAt: Math.min(at + 30_000, job.deadlineAt) });
        return { admission: { ...admission, claimId }, owner: job.owner, createdAt: job.createdAt, inputManifest: job.inputManifest, requestKey: job.inputRequestKey };
      });
    },
    async startAnalysis(admission) {
      return firestore.runTransaction(async transaction => {
        const ref = jobRef(admission.jobId); const job = (await transaction.get(ref)).data(); const at = now();
        if (!job || job.queueVersion !== 1 || job.done || job.executionState !== 'preparing' || job.runId !== admission.runId
          || job.claimId !== admission.claimId || job.claimExpiresAt <= at || job.deadlineAt <= at) return false;
        // After this commit, no lease takeover is allowed to invoke paid AI.
        transaction.update(ref, { executionState: 'executing', startedAt: at }); return true;
      });
    },
    async readAnalysisInput(claim) {
      const { admission, inputManifest } = claim;
      if (!Number.isSafeInteger(inputManifest?.chunks) || inputManifest.chunks < 1 || inputManifest.chunks > 18) throw new Error('Invalid analysis input manifest');
      const documents = await firestore.getAll(...Array.from({ length: inputManifest.chunks }, (_, i) => chunkRef(admission.jobId, i)));
      const chunks = documents.map((doc, i) => {
        const value = doc.data();
        if (!value || value.jobId !== admission.jobId || value.runId !== admission.runId || value.index !== i) throw new Error('Missing analysis input');
        return value.bytes;
      });
      return decodeAnalysisQueueInput(inputManifest, chunks, queueKeys, { owner: claim.owner, jobId: admission.jobId, requestDigest: claim.requestKey });
    },
    async stageAnalysisResult(admission, result) {
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 700 * 1024) result = { status: 'error', code: 'ANALYSIS_FAILED', message: '解析結果の保存上限を超えました。' };
      return firestore.runTransaction(async transaction => {
        const ref = jobRef(admission.jobId); const job = (await transaction.get(ref)).data();
        if (!job || job.queueVersion !== 1 || job.runId !== admission.runId || job.done) return false;
        if (job.executionState === 'resultReady') return true;
        if (job.executionState !== 'executing' || job.claimId !== admission.claimId) return false;
        const at = now();
        transaction.update(ref, { executionState: 'resultReady', result: at >= job.deadlineAt ? interrupted : result, resultReceivedAt: at });
        return true;
      });
    },
    async finish(admission, result) {
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 700 * 1024) {
        result = { status: 'error', code: 'ANALYSIS_FAILED', message: '解析結果の保存上限を超えました。' };
      }
      // Only a persisted, server-classified OpenAI no-result failure releases the monthly slot. Client disconnects never do.
      await firestore.runTransaction(async transaction => {
        const [jobDoc, globalDoc, decisionDoc] = await transaction.getAll(jobRef(admission.jobId), globalRef, chargeRef(admission.jobId));
        const job = jobDoc.data(); if (!job || job.runId !== admission.runId || job.done) return;
        const at = now();
        if (job.queueVersion === 1) {
          if (job.executionState !== 'resultReady' || !job.result) throw new Error('An analysis result must be durable before settlement');
          result = job.result;
        }
        const receivedAt = job.queueVersion === 1 ? job.resultReceivedAt : at;
        if (decisionDoc.exists) transaction.update(chargeRef(admission.jobId), { state: receivedAt < job.deadlineAt && result.status === 'error' && result.code === 'AI_SERVICE_NO_RESULT' ? 'refunded' : 'charged' });
        transaction.update(jobRef(admission.jobId), { done: true, result: receivedAt >= job.deadlineAt ? interrupted : result,
          ...(job.queueVersion === 1 ? { executionState: 'finished' } : {}) });
        if (job.queueVersion === 1) for (let i = 0; i < job.inputManifest.chunks; i++) transaction.delete(chunkRef(admission.jobId, i));
        if (globalDoc.exists) transaction.update(globalRef, { active: (globalDoc.data().active ?? [])
          .filter(item => item.jobId !== admission.jobId || item.runId !== admission.runId) });
      });
    },
    async progress(admission, stage) {
      if (!['product_verification', 'official_manual_analysis'].includes(stage)) return;
      await firestore.runTransaction(async transaction => {
        const ref = jobRef(admission.jobId); const job = (await transaction.get(ref)).data();
        if (job?.runId === admission.runId && !job.done && job.deadlineAt > now()) transaction.update(ref, { stage });
      });
    },
  };
  const { reserve: _reserve, ...api } = store;
  return api;
}
