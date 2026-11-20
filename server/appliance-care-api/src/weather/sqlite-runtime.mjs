import { DatabaseSync } from 'node:sqlite';
import { createRegionalWeatherStore } from './regional-store.mjs';
import { createMetWeatherService } from './met-service.mjs';

export function createSqliteWeatherStore(file, now, wake, recoveryRevision) {
  const database = new DatabaseSync(file, { timeout: 500 });
  database.exec(`PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS weather_regions (
      key TEXT PRIMARY KEY, ready_at INTEGER, state TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS weather_due ON weather_regions(ready_at) WHERE ready_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS weather_forecasts (key TEXT PRIMARY KEY, forecast TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS weather_control (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)`);
  const region = database.prepare(`SELECT weather_regions.state, weather_forecasts.forecast FROM weather_regions
    LEFT JOIN weather_forecasts USING(key) WHERE weather_regions.key=?`);
  const control = database.prepare('SELECT state FROM weather_control WHERE id=1');
  const pending = database.prepare('SELECT key FROM weather_regions WHERE ready_at>=0 AND ready_at<=? ORDER BY ready_at LIMIT 32');
  const earliest = database.prepare('SELECT ready_at FROM weather_regions WHERE ready_at>=0 ORDER BY ready_at LIMIT 1');
  const putRegion = database.prepare(`INSERT INTO weather_regions(key,ready_at,state) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET ready_at=excluded.ready_at,state=excluded.state`);
  const putControl = database.prepare(`INSERT INTO weather_control(id,state) VALUES(1,?)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state`);
  const putForecast = database.prepare(`INSERT INTO weather_forecasts(key,forecast) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET forecast=excluded.forecast WHERE weather_forecasts.forecast<>excluded.forecast`);
  const decode = row => row ? JSON.parse(row.state) : null;
  const readRegion = row => {
    const state = decode(row);
    if (state?.cache && row.forecast) state.cache.forecast = JSON.parse(row.forecast);
    return state;
  };
  const readyAt = row => row?.nextAttemptAt == null ? null : Math.max(row.nextAttemptAt, row.lease?.until ?? 0);
  if (recoveryRevision) {
    const gate = decode(control.get());
    if (gate?.haltReason === 'met_forbidden' && gate.recoveryRevision !== recoveryRevision) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const stamp = now();
        const blocked = database.prepare("SELECT key,state FROM weather_regions WHERE json_extract(state,'$.status')='blocked'");
        for (const row of blocked.all()) {
          const state = decode(row);
          const next = { ...state, status: 'queued', error: null, lease: null, nextAttemptAt: stamp };
          putRegion.run(row.key, stamp, JSON.stringify(next));
        }
        putControl.run(JSON.stringify({ ...gate, halted: false, haltReason: null, recoveryRevision }));
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); database.close(); throw error; }
    }
  }
  const store = createRegionalWeatherStore({ now,
    async read(key) { return readRegion(region.get(key)); },
    async readControl() { return decode(control.get()); },
    async due(stamp) { return pending.all(stamp).map(row => row.key); },
    async atomic(key, update, withGlobal) {
      let result, changed;
      database.exec('BEGIN IMMEDIATE');
      try {
        const stored = region.get(key); const current = readRegion(stored);
        result = update(current, withGlobal ? decode(control.get()) : null);
        if (result.region) {
          const state = result.region;
          if (state.cache) {
            const { forecast, ...metadata } = state.cache;
            if (!stored?.forecast || !result.cacheMetadata && forecast !== current?.cache?.forecast) putForecast.run(key, JSON.stringify(forecast));
            putRegion.run(key, readyAt(state), JSON.stringify({ ...state, cache: metadata }));
          } else putRegion.run(key, readyAt(state), JSON.stringify(state));
        }
        if (result.global) putControl.run(JSON.stringify(result.global));
        changed = Boolean(result.global || result.region && readyAt(current) !== readyAt(result.region));
        database.exec('COMMIT');
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
      if (changed) wake();
      return result.result;
    },
  });
  return {
    store,
    nextDeadline() {
      const next = earliest.get()?.ready_at;
      if (next === undefined) return null;
      const gate = decode(control.get());
      if (gate?.halted) return null;
      const stamp = now();
      const starts = (gate?.starts ?? []).filter(start => start + 1000 > stamp).sort((a, b) => a - b);
      const leases = Object.values(gate?.leases ?? {}).map(lease => lease.until).filter(until => until > stamp).sort((a, b) => a - b);
      return Math.max(next, gate?.notBefore ?? 0,
        starts.length >= 2 ? starts[starts.length - 2] + 1000 : 0, leases.length >= 4 ? leases[leases.length - 4] : 0);
    },
    close() { database.close(); },
  };
}

/** One listener and one SQLite connection on the self-hosted weather process. */
export function createSelfHostedWeather({ file, now = Date.now, onError = () => {}, recoveryRevision, ...upstream }) {
  let timer, running, stopped = false, scheduledAt = null;
  const storage = createSqliteWeatherStore(file, now, wake, recoveryRevision);
  const service = createMetWeatherService({ ...upstream, now, store: storage.store });
  function wake() {
    if (running || stopped || !service.configured) return;
    clearTimeout(timer);
    try {
      const deadline = storage.nextDeadline();
      scheduledAt = deadline;
      if (deadline !== null) timer = setTimeout(run, Math.max(0, Math.min(2_147_483_647, deadline - now())));
    } catch {
      onError();
      timer = setTimeout(wake, 30_000);
    }
  }
  function run() {
    if (scheduledAt !== null && scheduledAt > now()) { wake(); return; }
    scheduledAt = null;
    running = service.tick().then(
      () => { running = undefined; wake(); },
      () => {
        running = undefined;
        onError();
        if (!stopped) timer = setTimeout(wake, 30_000);
      },
    );
  }
  wake();
  return { service: { ...service, async read(id) {
    if (scheduledAt !== null && scheduledAt <= now()) wake();
    return service.read(id);
  } }, async close() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    await running;
    storage.close();
  } };
}
