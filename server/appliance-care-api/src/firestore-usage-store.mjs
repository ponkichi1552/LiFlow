import { randomBytes, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { PUBLIC_API_POLICY, PublicApiError, publicJobId, publicKey, publicUsage, usagePeriods } from './public-access.mjs';
import { prepareAnalysisQueueInput, prepareEncryptedAnalysisQueueInput, decodeAnalysisQueueInput, captureAnalysisQueueKeys } from './analysis-queue-input.mjs';
import { analysisDeliveryJson, validAnalysisDelivery } from './analysis-delivery-contract.mjs';
import { manualPreflightErrorCodes } from './manual-upload-server.mjs';
import { deviceProofTemporary } from './native-device-authorization.mjs';

const interrupted = { status: 'error', code: 'ANALYSIS_INTERRUPTED',
  message: '解析が中断されました。受付済みの1回分は記録されています。時間をおいて再試行してください。' };
const unstarted = { status: 'error', code: 'ANALYSIS_INTERRUPTED',
  message: '説明書の受付が中断されました。時間をおいて再試行してください。' };
const encryptedAndUnstarted = job => job.inputManifest?.version === 3 && !Number.isSafeInteger(job.startedAt);
const shouldRefundAnalysis = (job, result, receivedAt) => encryptedAndUnstarted(job)
  || (Number.isSafeInteger(receivedAt) && receivedAt < job.deadlineAt && result?.status === 'error' && result.code === 'AI_SERVICE_NO_RESULT');
const expiredAdmission = () => new PublicApiError(409, 'REQUEST_CONFLICT', 'この受付IDの結果保存期間は終了しました。新しい操作としてやり直してください。');
const workStates = ['resultReady', 'queued', 'preparing', 'executing'];
const installationDigest = principal => publicKey(JSON.stringify([principal.deviceId, principal.installationId]));
const canReadJob = (job, principal) => job?.owner === principal.uid
  && (job.installationDigest === undefined || job.installationDigest === installationDigest(principal));

/** Server-only documents. All counters and the job reservation commit together before any paid work begins. */
export function createFirestoreUsageStore({ firestore, policy = PUBLIC_API_POLICY, now = Date.now, analysisQueueKeys, manualUploadPrivateKeys }) {
  const queueKeys = captureAnalysisQueueKeys(analysisQueueKeys);
  const canDecrypt = manifest => manifest?.version === 3 ? manualUploadPrivateKeys?.has(manifest.keyId)
    : [1, 2].includes(manifest?.version) && queueKeys?.keys.has(manifest.keyId);
  for (const key of Object.keys(PUBLIC_API_POLICY)) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) throw new Error('Invalid public API policy');
  }
  const root = firestore.collection('applianceApi').doc('v1');
  const globalRef = root.collection('control').doc('global');
  const workerRef = root.collection('control').doc('analysisWorker');
  const cleanupRef = root.collection('control').doc('analysisCleanup');
  const keyedWorkerRef = keyId => root.collection('control').doc(`analysisWorker.${keyId}`);
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
  function checkPrincipal(principal, at = now()) {
    if (!principal || typeof principal.uid !== 'string' || !principal.uid || principal.anonymous !== false
      || !/^[a-f0-9]{64}$/u.test(principal.deviceId) || typeof principal.installationId !== 'string'
      || !/^[A-Za-z0-9_.:-]{16,200}$/u.test(principal.installationId)) {
      throw new PublicApiError(403, 'DEVICE_VERIFICATION_REQUIRED', '本人と端末の継続性を確認できないため解析できません。');
    }
    if (principal.deviceVerifiedUntil !== undefined && (!Number.isSafeInteger(principal.deviceVerifiedUntil) || principal.deviceVerifiedUntil <= at)) {
      throw deviceProofTemporary(at + 1000);
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
      checkPrincipal(principal, at);
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
    if (job.deliveredAt !== undefined) return { stage: job.stage, done: true,
      result: { status: 'error', code: 'JOB_NOT_FOUND', message: '解析結果は端末に保存済みです。' }, usage: job.usage };
    if (!job.done && job.executionState !== 'resultReady' && job.deadlineAt <= at && !encryptedAndUnstarted(job)) {
      return { stage: job.stage, done: true, result: interrupted, usage: job.usage };
    }
    return { stage: job.stage, done: job.done, ...(job.done ? { result: job.result,
      ...(job.delivery ? { delivery: job.delivery } : {}) } : { pollAfterMs: 2000 }), usage: job.usage };
  }
  function releaseActiveRun(transaction, global, jobId, runId) {
    const active = global?.active ?? [];
    const remaining = active.filter(item => item.jobId !== jobId || item.runId !== runId);
    if (remaining.length !== active.length) transaction.update(globalRef, { active: remaining });
  }
  function deleteAnalysisInput(transaction, jobId, job) {
    if (job.queueVersion === 1 && job.inputManifest) {
      for (let index = 0; index < job.inputManifest.chunks; index++) transaction.delete(chunkRef(jobId, index));
    }
  }
  function pruneUnsettledJob(ref, at) {
    return firestore.runTransaction(async transaction => {
      const [jobDoc, decisionDoc, globalDoc] = await transaction.getAll(ref, chargeRef(ref.id), globalRef);
      const job = jobDoc.data();
      if (!job || job.expiresAt.toMillis() > at.getTime()) return false;
      if (!job.done) {
        if (decisionDoc.data()?.state === 'pending') {
          const refund = shouldRefundAnalysis(job, job.executionState === 'resultReady' ? job.result : undefined, job.resultReceivedAt);
          transaction.update(decisionDoc.ref, { state: refund ? 'refunded' : 'charged' });
        }
        deleteAnalysisInput(transaction, ref.id, job);
        releaseActiveRun(transaction, globalDoc.data(), ref.id, job.runId);
      }
      transaction.delete(ref);
      return true;
    });
  }
  const store = {
    async ready() { await globalRef.get(); },
    async pruneIfDue() {
      const claimed = await firestore.runTransaction(async transaction => {
        const current = (await transaction.get(cleanupRef)).data(); const at = now();
        if (Number.isSafeInteger(current?.nextAttemptAt) && current.nextAttemptAt > at) return null;
        const nonce = randomUUID();
        transaction.set(cleanupRef, { nonce, nextAttemptAt: at + 120_000 }); return nonce;
      });
      if (!claimed) return 0;
      const count = await store.prune();
      await firestore.runTransaction(async transaction => {
        const current = (await transaction.get(cleanupRef)).data();
        if (current?.nonce === claimed) transaction.set(cleanupRef, { nextAttemptAt: count >= 50 ? now() : now() + 60 * 60_000 });
      });
      return count;
    },
    async prune() {
      const at = new Date(now()); const batch = firestore.batch(); let deletedJobs = 0; let batched = 0;
      for (const collection of ['jobs', 'reuse', 'usage', 'dailyUsage', 'deviceUsage', 'chargeDecisions', 'quotaStates', 'analysisInputChunks', 'appleAttestations', 'androidEnrollments']) {
        const expired = await root.collection(collection).where('expiresAt', '<=', at).limit(50)
          .select(...(collection === 'jobs' ? ['expiresAt', 'done'] : ['expiresAt'])).get();
        // A cache pointer may be renewed after the query; never delete a newer value from that stale result.
        for (const doc of expired.docs) {
          if (collection === 'jobs' && doc.data().done !== true) {
            if (await pruneUnsettledJob(doc.ref, at)) deletedJobs++;
          } else {
            batch.delete(doc.ref, { lastUpdateTime: doc.updateTime }); batched++;
          }
        }
      }
      if (batched) await batch.commit();
      return deletedJobs + batched;
    },
    async admit(input) {
      const principal = Object.freeze({ uid: input.principal?.uid, anonymous: input.principal?.anonymous,
        deviceId: input.principal?.deviceId, installationId: input.principal?.installationId, deviceVerifiedUntil: input.principal?.deviceVerifiedUntil });
      checkPrincipal(principal);
      const captured = { principal, requestKey: input.requestKey, forceReanalysis: input.forceReanalysis === true, idempotencyKey: input.idempotencyKey,
      };
      const key = publicKey(JSON.stringify({ principal, requestKey: captured.requestKey, forceReanalysis: captured.forceReanalysis, idempotencyKey: captured.idempotencyKey }));
      const existing = admitting.get(key);
      if (existing) { const receipt = await existing; return { jobId: receipt.jobId, created: false, usage: receipt.usage }; }
      if (admitting.size >= 256) throw new PublicApiError(429, 'RATE_LIMITED', '受付が混み合っています。少し待ってください。');
      if (input.encryptedInput) captured.queuedInput = prepareEncryptedAnalysisQueueInput(input.encryptedInput, input.requestKey);
      else if (input.analysisRequest) captured.queuedInput = prepareAnalysisQueueInput(input.analysisRequest, input.requestKey, queueKeys,
        { owner: principal.uid, jobId: publicJobId(principal, input.idempotencyKey), requestDigest: publicKey(input.requestKey) });
      const pending = store.reserve(captured); admitting.set(key, pending);
      try { return await pending; } finally { if (admitting.get(key) === pending) admitting.delete(key); }
    },
    async reserve({ principal, requestKey, forceReanalysis, idempotencyKey, queuedInput }) {
      checkPrincipal(principal);
      // Identity and request data are copied by the HTTP boundary before this asynchronous transaction.
      const requestDigest = publicKey(JSON.stringify([requestKey, forceReanalysis]));
      const admission = await firestore.runTransaction(async transaction => {
        const at = now(); const periods = usagePeriods(at);
        checkPrincipal(principal, at);
        const id = publicJobId(principal, idempotencyKey); const ref = jobRef(id);
        // A result disappears after the requesting installation saves it. Giving
        // another installation the same job would let the first receipt erase its result.
        const reuseRef = root.collection('reuse').doc(publicKey(JSON.stringify([
          principal.uid, principal.deviceId, principal.installationId, requestKey,
        ])));
        const [jobDoc, globalDoc, userDoc, dailyDoc, reuseDoc, deviceDoc, chargeDoc, admissionDoc] = await transaction.getAll(ref, globalRef,
          userRef(principal.uid, periods.month), dayRef(periods.day), reuseRef, deviceRef(principal.deviceId, periods.month), chargeRef(id), admissionRef(id));
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
          if (!canReadJob(previous, principal) || previous.requestDigest !== jobRequestDigest || previous.expiresAt.toMillis() <= at) {
            return { denied: expiredAdmission() };
          }
          return { jobId: receipt.jobId, created: false, usage: publicUsage(state.count, at, policy) };
        }
        if (job) {
          if (!canReadJob(job, principal) || job.requestDigest !== requestDigest) throw new PublicApiError(409, 'REQUEST_CONFLICT', '同じ受付IDで異なる解析は開始できません。');
          // A missing result is never transparently re-run after a crash: it may already have incurred cost.
          transaction.create(admissionRef(id), { owner: principal.uid, requestDigest, jobRequestDigest: requestDigest, jobId: id });
          writeQuota(transaction, principal, periods, state);
          return { jobId: id, created: false, usage: publicUsage(state.count, at, policy) };
        }
        if (chargeDoc.exists) { writeQuota(transaction, principal, periods, state); return { denied: expiredAdmission() }; }
        const reusedId = reuseDoc.data()?.jobId;
        if (!forceReanalysis && reusedId) {
          const previous = (await transaction.get(jobRef(reusedId))).data();
          if (canReadJob(previous, principal) && previous.expiresAt.toMillis() > at
            && (previous.result?.status === 'verified' && (previous.done || previous.executionState === 'resultReady')
              || !previous.done && previous.deadlineAt > at)) {
            transaction.create(admissionRef(id), { owner: principal.uid, requestDigest, jobRequestDigest: previous.requestDigest, jobId: reusedId });
            writeQuota(transaction, principal, periods, state);
            return { jobId: reusedId, created: false, usage: publicUsage(state.count, at, policy) };
          }
        }
        if (queuedInput) {
          const { version, keyId } = queuedInput.manifest;
          const heartbeat = (await transaction.get(version === 3 ? keyedWorkerRef(keyId) : workerRef)).data();
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
        transaction.create(ref, { owner: principal.uid, installationDigest: installationDigest(principal), requestDigest, runId, stage: 'product_verification', done: false,
          createdAt: at, deadlineAt, usage, expiresAt: new Date(at + policy.retentionMs),
          ...(queuedInput ? { queueVersion: 1, executionState: 'queued', inputManifest: queuedInput.manifest, inputRequestKey: publicKey(requestKey) } : {}) });
        if (queuedInput) for (const [index, bytes] of queuedInput.chunks.entries()) transaction.create(chunkRef(id, index), {
          jobId: id, index, runId, bytes, expiresAt: new Date(deadlineAt) });
        return { jobId: id, created: true, runId, deadlineAt, usage };
      });
      if (admission.denied) throw admission.denied;
      return admission;
    },
    async lookupAdmission(principal, key) {
      checkPrincipal(principal);
      const id = publicJobId(principal, key);
      const receipt = (await admissionRef(id).get()).data();
      if (receipt && (receipt.owner !== principal.uid || !/^[a-f0-9]{64}$/u.test(receipt.jobId))) throw expiredAdmission();
      const jobId = receipt?.jobId ?? id;
      const [snapshot] = await firestore.getAll(jobRef(jobId), { fieldMask: ['owner', 'installationDigest', 'requestDigest', 'expiresAt'] });
      const job = snapshot.data();
      if (canReadJob(job, principal) && job.expiresAt.toMillis() > now()
        && (!receipt || job.requestDigest === (receipt.jobRequestDigest ?? receipt.requestDigest))) return { jobId };
      if (receipt || job || (await chargeRef(id).get()).exists) throw expiredAdmission();
      return null;
    },
    async read(principal, id) {
      checkPrincipal(principal);
      if (!/^[a-f0-9]{64}$/u.test(id)) return null;
      const job = (await jobRef(id).get()).data(); const at = now();
      // Identical response for absent jobs, another user and expired results.
      if (!canReadJob(job, principal) || job.expiresAt.toMillis() <= at) return null;
      const output = readable(job, at);
      // Progress reads need no additional quota transaction. The final response refreshes the counter once.
      if (output.done) output.usage = await readUsage(principal);
      return output;
    },
    async acknowledgeResult(principal, id, delivery) {
      if (!principal?.uid || !/^[a-f0-9]{64}$/u.test(id) || !validAnalysisDelivery(delivery)) return false;
      return firestore.runTransaction(async transaction => {
        const ref = jobRef(id); const job = (await transaction.get(ref)).data(); const at = now();
        if (!job || job.owner !== principal.uid || job.expiresAt.toMillis() <= at || !job.done) return false;
        const tokenDigest = publicKey(delivery.token);
        if (job.deliveredAt !== undefined) return job.deliveryProof?.tokenDigest === tokenDigest
          && job.deliveryProof?.digest === delivery.digest && delivery.expiresAt === job.expiresAt.toMillis();
        if (!job.result || !validAnalysisDelivery(job.delivery) || job.delivery.token !== delivery.token
          || job.delivery.digest !== delivery.digest || job.delivery.expiresAt !== delivery.expiresAt) return false;
        // Replacement removes every result/input field. A merge would retain the private content.
        transaction.set(ref, { owner: job.owner, ...(job.installationDigest ? { installationDigest: job.installationDigest } : {}),
          requestDigest: job.requestDigest, runId: job.runId, stage: job.stage,
          done: true, createdAt: job.createdAt, deadlineAt: job.deadlineAt, usage: job.usage, expiresAt: new Date(job.expiresAt.toMillis()),
          deliveredAt: at, deliveryProof: { tokenDigest, digest: delivery.digest } });
        if (job.inputManifest) for (let i = 0; i < job.inputManifest.chunks; i++) transaction.delete(chunkRef(id, i));
        return true;
      });
    },
    async usage(principal) { return synchronize(principal); },
    /** A separate request-independent worker owns these server-only operations. */
    async heartbeatAnalysisWorker() {
      const at = now(); if (!Number.isSafeInteger(at)) throw new Error('Invalid worker clock');
      const lease = { seenAt: at, readyUntil: at + 90_000 };
      await firestore.runTransaction(async transaction => {
        if (queueKeys || !manualUploadPrivateKeys?.size) transaction.set(workerRef, lease);
        for (const keyId of manualUploadPrivateKeys?.keys() ?? []) transaction.set(keyedWorkerRef(keyId), lease);
      });
    },
    async listAnalysisWork(limit = 3) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid worker limit');
      // Non-due production leases are bounded by admission concurrency. Extra slots allow this
      // worker to see actionable jobs even when the first rows use a different upload key.
      const snapshot = await root.collection('jobs').where('executionState', 'in', workStates)
        .limit(policy.maxConcurrent + limit)
        .select('executionState', 'deadlineAt', 'claimExpiresAt', 'queueVersion', 'done', 'inputManifest').get();
      const at = now();
      return snapshot.docs.flatMap(doc => {
        const job = doc.data(); const state = job.executionState;
        if (job.queueVersion !== 1 || job.done || state === 'executing' && job.deadlineAt > at
          || state === 'preparing' && job.claimExpiresAt > at) return [];
        if ((state === 'queued' || state === 'preparing') && job.deadlineAt > at && !canDecrypt(job.inputManifest)) return [];
        return [{ id: doc.id, priority: workStates.indexOf(state), deadline: job.deadlineAt }];
      }).sort((left, right) => left.priority - right.priority || left.deadline - right.deadline).slice(0, limit).map(job => job.id);
    },
    async claimAnalysis(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid analysis job');
      return firestore.runTransaction(async transaction => {
        const ref = jobRef(id); const job = (await transaction.get(ref)).data(); const at = now();
        if (!job || job.queueVersion !== 1 || job.done) return null;
        const admission = { jobId: id, runId: job.runId, deadlineAt: job.deadlineAt };
        if (job.executionState === 'resultReady') return { admission, result: job.result };
        if (job.deadlineAt <= at && ['queued', 'preparing', 'executing'].includes(job.executionState)) {
          const result = encryptedAndUnstarted(job) ? unstarted : interrupted;
          transaction.update(ref, { executionState: 'resultReady', result, resultReceivedAt: at });
          return { admission, result };
        }
        if (job.executionState !== 'queued' && !(job.executionState === 'preparing' && job.claimExpiresAt <= at)) return null;
        if (!canDecrypt(job.inputManifest)) return null;
        // Input preparation can be leased safely; the separate start transition
        // fences this claim immediately before the first possible paid request.
        const claimId = randomUUID();
        transaction.update(ref, { executionState: 'preparing', claimId, claimExpiresAt: Math.min(at + 30_000, job.deadlineAt) });
        return { admission: { ...admission, claimId }, owner: job.owner, createdAt: job.createdAt, inputManifest: job.inputManifest, requestKey: job.inputRequestKey };
      });
    },
    async renewAnalysisPreparation(admission) {
      return firestore.runTransaction(async transaction => {
        const ref = jobRef(admission.jobId);
        const job = (await transaction.get(ref)).data(); const at = now();
        if (!job || job.runId !== admission.runId || job.claimId !== admission.claimId || job.executionState !== 'preparing'
          || job.done || at >= job.claimExpiresAt || at >= job.deadlineAt) return false;
        transaction.update(ref, { claimExpiresAt: Math.min(at + 30_000, job.deadlineAt) });
        return true;
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
      return decodeAnalysisQueueInput(inputManifest, chunks, queueKeys,
        { owner: claim.owner, jobId: admission.jobId, requestDigest: claim.requestKey }, manualUploadPrivateKeys);
    },
    async stageAnalysisResult(admission, result, { beforeStart = false } = {}) {
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 700 * 1024) result = { status: 'error', code: 'ANALYSIS_FAILED', message: '解析結果の保存上限を超えました。' };
      return firestore.runTransaction(async transaction => {
        const ref = jobRef(admission.jobId); const job = (await transaction.get(ref)).data();
        if (!job || job.queueVersion !== 1 || job.runId !== admission.runId || job.done) return false;
        if (job.executionState === 'resultReady') return true;
        const at = now();
        if (job.claimId !== admission.claimId) return false;
        if (beforeStart) {
          if (!encryptedAndUnstarted(job) || job.executionState !== 'preparing' || at >= job.claimExpiresAt
            || at >= job.deadlineAt || result.status !== 'error' || !manualPreflightErrorCodes.includes(result.code)) return false;
        } else if (job.executionState !== 'executing') return false;
        transaction.update(ref, { executionState: 'resultReady', result: at >= job.deadlineAt ? interrupted : result, resultReceivedAt: at });
        return true;
      });
    },
    async finish(admission, result) {
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 700 * 1024) {
        result = { status: 'error', code: 'ANALYSIS_FAILED', message: '解析結果の保存上限を超えました。' };
      }
      // A worker-settled preflight rejection or an OpenAI no-result failure releases the monthly slot.
      await firestore.runTransaction(async transaction => {
        const [jobDoc, globalDoc, decisionDoc] = await transaction.getAll(jobRef(admission.jobId), globalRef, chargeRef(admission.jobId));
        const job = jobDoc.data(); if (!job || job.runId !== admission.runId || job.done) return;
        const at = now();
        if (job.queueVersion === 1) {
          if (job.executionState !== 'resultReady' || !job.result) throw new Error('An analysis result must be durable before settlement');
          result = job.result;
        }
        const receivedAt = job.queueVersion === 1 ? job.resultReceivedAt : at;
        const neverStarted = encryptedAndUnstarted(job);
        const refund = shouldRefundAnalysis(job, result, receivedAt);
        if (decisionDoc.exists) transaction.update(chargeRef(admission.jobId), { state: refund ? 'refunded' : 'charged' });
        const output = receivedAt >= job.deadlineAt ? (neverStarted ? unstarted : interrupted) : result;
        transaction.update(jobRef(admission.jobId), { done: true, result: output,
          delivery: { token: randomBytes(32).toString('hex'), digest: publicKey(analysisDeliveryJson(output)), expiresAt: job.expiresAt.toMillis() },
          ...(job.queueVersion === 1 ? { executionState: 'finished', inputManifest: null, inputRequestKey: null } : {}) });
        deleteAnalysisInput(transaction, admission.jobId, job);
        releaseActiveRun(transaction, globalDoc.data(), admission.jobId, admission.runId);
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
