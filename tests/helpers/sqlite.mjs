import { DatabaseSync } from 'node:sqlite';

export function createDatabase(path = ':memory:') {
  const connection = new DatabaseSync(path);
  const writes = [];
  return {
    connection,
    writes,
    database: {
      async isInTransactionAsync() { return connection.isTransaction; },
      async execAsync(sql) { connection.exec(sql); },
      async runAsync(sql, ...params) {
        writes.push({ sql, params });
        const result = connection.prepare(sql).run(...params);
        return { ...result, lastInsertRowId: Number(result.lastInsertRowid) };
      },
      async getFirstAsync(sql, ...params) { return connection.prepare(sql).get(...params) ?? null; },
      async getAllAsync(sql, ...params) { return connection.prepare(sql).all(...params); },
      async withTransactionAsync(callback) {
        connection.exec('BEGIN');
        try {
          await callback();
          connection.exec('COMMIT');
        } catch (error) {
          connection.exec('ROLLBACK');
          throw error;
        }
      },
    },
  };
}
