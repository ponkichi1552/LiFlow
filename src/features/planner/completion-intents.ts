export interface CompletionIntent<T> {
  id: string;
  key: string;
  target: T;
  completed: boolean;
  createdAt: string;
  status: 'queued' | 'committed' | 'failed';
}
export interface CompletionIntentStore<T> {
  load(): Promise<readonly CompletionIntent<T>[]>;
  save(values: readonly CompletionIntent<T>[]): Promise<void>;
}
export interface CompletionIntentState {
  values: ReadonlyMap<string, boolean>;
  pending: ReadonlySet<string>;
  failed: ReadonlySet<string>;
  restored: boolean;
  error: string | null;
}

/** A saved user request is separate from authenticated history and presentation.
 * Each executor must atomically deduplicate intent.id with its actual write.
 * Only one write runs at a time; a newer gesture always keeps its own overlay.
 */
export function createCompletionIntents<T>(options: {
  store: CompletionIntentStore<T>;
  capture(target: T): T;
  prepareRequest?(target: T, previous: Readonly<CompletionIntent<T>> | undefined): T;
  makeId(): string;
  now(): Date;
  isCurrent(): boolean;
  apply(intent: Readonly<CompletionIntent<T>>): Promise<void>;
  refresh(): Promise<void | boolean>;
}) {
  const requests = new Map<string, CompletionIntent<T>>();
  const acknowledged = new Map<string, CompletionIntent<T>>();
  const durable = new Set<string>();
  const touched = new Set<string>();
  const listeners = new Set<() => void>();
  let active = false;
  let initialized: Promise<void> | undefined;
  let persistence: Promise<void> = Promise.resolve();
  let worker: Promise<void> | undefined;
  let reading: Promise<void> | undefined;
  let readAgain = false;
  let revision = 0, savedRevision = -1;
  let state: CompletionIntentState = { values: new Map(), pending: new Set(), failed: new Set(), restored: false, error: null };
  const current = () => active && options.isCurrent();
  function emit(error = state.error) {
    if (error === null && [...requests.values()].some(item => item.status === 'failed')) error = '一部の家事を保存できませんでした。再試行できます。';
    const visible = [...requests.values()].filter(item => item.status !== 'failed');
    const values = new Map(visible.map(item => [item.key, item.completed]));
    const pending = new Set(visible.map(item => item.key));
    const failed = new Set([...requests.values()].filter(item => item.status === 'failed').map(item => item.key));
    state = { values: values.size === state.values.size && [...values].every(([key, value]) => state.values.get(key) === value) ? state.values : values,
      pending: pending.size === state.pending.size && [...pending].every(key => state.pending.has(key)) ? state.pending : pending,
      failed: failed.size === state.failed.size && [...failed].every(key => state.failed.has(key)) ? state.failed : failed,
      restored: state.restored, error };
    for (const listener of listeners) try { listener(); } catch { /* View listeners cannot cancel a saved request. */ }
  }
  const copy = (value: CompletionIntent<T>): CompletionIntent<T> => ({ ...value, target: options.capture(value.target) });
  function initialize() {
    if (initialized) return initialized;
    const pending = options.store.load().then(saved => {
      if (saved.length > 128) throw new Error('保存待ちの家事を確認できません。');
      const keys = new Set<string>(); const ids = new Set<string>();
      const captured = saved.map(value => {
        if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 200
          || typeof value.key !== 'string' || !value.key || value.key.length > 2000 || typeof value.completed !== 'boolean'
          || !['queued', 'committed', 'failed'].includes(value.status) || !Number.isFinite(Date.parse(value.createdAt))
          || keys.has(value.key) || ids.has(value.id)) throw new Error('保存待ちの家事を確認できません。');
        keys.add(value.key); ids.add(value.id); return copy(value);
      });
      for (const value of captured) if (!touched.has(value.key)) { requests.set(value.key, value); durable.add(value.id); }
      touched.clear();
      state = { ...state, restored: true }; emit();
    });
    initialized = pending;
    void pending.catch(() => { if (initialized === pending) initialized = undefined; });
    return pending;
  }
  function persist(): Promise<void> {
    const pending = persistence.then(async () => {
      await initialize();
      if (savedRevision === revision) return;
      const writingRevision = revision;
      const values = [...requests.values()];
      // A gesture can arrive before a full protected journal is restored. Keep
      // both in memory, but never evict an older durable request to store it.
      // Acknowledging the restored batch frees space for the waiting gesture.
      const snapshot = (values.length <= 128 ? values : [
        ...values.filter(item => durable.has(item.id)),
        ...values.filter(item => !durable.has(item.id)),
      ].slice(0, 128)).map(copy);
      await options.store.save(snapshot);
      savedRevision = writingRevision;
      for (const item of snapshot) if (requests.get(item.key)?.id === item.id) durable.add(item.id);
    });
    persistence = pending.catch(() => undefined);
    return pending;
  }
  function refreshCommitted() {
    if (reading || !current()) return;
    const confirmed = [...requests.values()].filter(item => item.status === 'committed').map(item => [item.key, item.id] as const);
    if (!confirmed.length) return;
    let refreshed = false;
    const pending = (async () => {
      try {
        if (await options.refresh() === false) return;
        if (!current()) return;
        refreshed = true;
        const clearing: CompletionIntent<T>[] = [];
        for (const [key, id] of confirmed) if (requests.get(key)?.id === id && requests.get(key)?.status === 'committed') {
          const item = requests.get(key)!; clearing.push(item);
          acknowledged.delete(key); acknowledged.set(key, copy(item));
          if (acknowledged.size > 128) acknowledged.delete(acknowledged.keys().next().value!);
          requests.delete(key); durable.delete(id);
          revision++;
        }
        try { await persist(); }
        catch (cause) {
          // Keep the read-only recovery path when protected acknowledgement
          // storage fails. A newer gesture for the same key always wins.
          for (const item of clearing) if (!requests.has(item.key)) {
            requests.set(item.key, item); durable.add(item.id); revision++;
          }
          throw cause;
        }
        emit(null); drain();
      } catch {
        refreshed = false;
        // Successful history is never undone or repeated because a read failed.
        emit('保存済みです。表示の更新を再試行してください。');
      }
    })();
    reading = pending;
    void pending.finally(() => {
      if (reading === pending) reading = undefined;
      const retryRequested = readAgain; readAgain = false;
      // A newer completion can commit while the previous presentation is read.
      // Confirm it with another read; a failed read still requires explicit retry.
      if ((refreshed || retryRequested) && [...requests.values()].some(item => item.status === 'committed')) refreshCommitted();
    }).catch(() => undefined);
  }
  function drain() {
    if (worker || !current() || !state.restored) return;
    const pending = (async () => {
      while (current()) {
        const item = [...requests.values()].find(value => value.status === 'queued' && durable.has(value.id));
        if (!item) break;
        let applied = false;
        try {
          await options.apply(copy(item));
          applied = true;
          if (requests.get(item.key)?.id === item.id) { requests.set(item.key, { ...item, status: 'committed' }); revision++; }
          await persist(); emit();
        } catch (error) {
          if (requests.get(item.key)?.id === item.id) { requests.set(item.key, { ...item, status: applied ? 'committed' : 'failed' }); revision++; }
          // Keep the failed request for inspection/retry; never pretend it was stored as history.
          try { await persist(); } catch { /* The previous protected request remains recoverable. */ }
          emit(applied ? '保存済みです。表示の更新を再試行してください。'
            : error instanceof Error ? error.message : '保存できませんでした。もう一度お試しください。');
        }
      }
    })();
    worker = pending;
    void pending.finally(() => {
      if (worker === pending) worker = undefined;
      if (current()) {
        if ([...requests.values()].some(item => item.status === 'queued' && durable.has(item.id))) drain();
        else refreshCommitted();
      }
    }).catch(() => undefined);
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async activate() {
      active = true;
      try { await initialize(); if (current()) drain(); }
      catch { emit('保存待ちの家事を読み込めませんでした。再試行してください。'); }
    },
    deactivate() { active = false; },
    request(key: string, target: T, completed: boolean) {
      if (!current() || typeof completed !== 'boolean') return false;
      if (!key || key.length > 2000 || !requests.has(key) && requests.size >= 128) {
        emit(state.failed.size ? '保存できなかった家事があります。保存を再試行してください。' : '保存待ちの家事が多いため、少し待ってから操作してください。'); return false;
      }
      let item: CompletionIntent<T>;
      try {
        const id = options.makeId();
        if (!id || id.length > 200) throw new Error('操作を準備できませんでした。');
        const previous = requests.get(key) ?? acknowledged.get(key);
        const captured = options.capture(target);
        item = { id, key, target: options.capture(options.prepareRequest ? options.prepareRequest(captured, previous ? copy(previous) : undefined) : captured), completed, createdAt: options.now().toISOString(), status: 'queued' };
      } catch { emit('操作を準備できませんでした。'); return false; }
      if (!state.restored) touched.add(key);
      const previous = requests.get(key); if (previous) durable.delete(previous.id);
      requests.set(key, item); revision++; emit(null);
      void persist().then(drain).catch(() => {
        if (requests.get(key)?.id === item.id) { requests.set(key, { ...item, status: 'failed' }); revision++; }
        emit('端末に保存できませんでした。もう一度お試しください。');
      });
      return true;
    },
    retryFailed() {
      if (!current()) return;
      const retrying = [...requests.values()].filter(item => item.status === 'failed');
      if (!retrying.length) return;
      for (const item of retrying) {
        requests.set(item.key, { ...item, status: 'queued' }); durable.delete(item.id); revision++;
      }
      emit(null);
      // Retain the original id, target and gesture timestamp. A lost business
      // acknowledgement is replayed idempotently, never as a second completion.
      void persist().then(drain).catch(() => {
        for (const item of retrying) if (requests.get(item.key)?.id === item.id && !durable.has(item.id)) {
          requests.set(item.key, { ...item, status: 'failed' }); revision++;
        }
        emit('端末に保存できませんでした。もう一度お試しください。');
      });
    },
    retryRead() {
      if (!state.restored && current()) {
        void initialize().then(() => { if (current()) { emit(null); drain(); refreshCommitted(); } })
          .catch(() => emit('保存待ちの家事を読み込めませんでした。再試行してください。'));
        return;
      }
      // A display can mount while the previous read is still discovering that
      // no screen is focused. Keep that explicit retry until the read settles.
      if (reading) readAgain = true;
      else refreshCommitted();
    },
    async settled() {
      for (;;) {
        const p = persistence, w = worker, r = reading;
        await p; await w; await r;
        if (p === persistence && w === worker && r === reading) return;
      }
    },
  };
}
export type CompletionIntents<T> = ReturnType<typeof createCompletionIntents<T>>;
