import type { SQLiteDatabase } from 'expo-sqlite';
import { validateWidgetCompletionOperation } from '../../features/widgets/completion-operation.ts';
import type { WidgetCompletionOperation } from '../../features/widgets/completion-operation.ts';
import { withPlannerDatabaseOperation } from './repository.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { sharedDocumentDigest } from '../../features/sharing/crypto.ts';

export function quarantineWidgetCompletionInput(database: SQLiteDatabase, raw: unknown, reason: string, queuedId?: string, queuedJson?: string): Promise<void> {
  return withPlannerDatabaseOperation(database, () => withIsolatedSqliteTransaction(database, async tx => {
    const json = queuedJson ?? JSON.stringify(raw);
    const digest = sharedDocumentDigest({ json });
    await tx.runAsync('INSERT OR IGNORE INTO widget_rejected_inputs VALUES(?,?,?)', digest, json, reason);
    if (queuedId !== undefined) await tx.runAsync('DELETE FROM native_widget_completion_intents WHERE operation_id=? AND operation_json=?', queuedId, json);
  }));
}

/** Read a bounded native input queue. No completion, calendar, or Google state is changed here. */
export function readNativeWidgetCompletionOperations(database: SQLiteDatabase): Promise<WidgetCompletionOperation[]> {
  return withPlannerDatabaseOperation(database, async () => {
    if (!await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE name='native_widget_completion_intents'")) return [];
    const rows = await database.getAllAsync<{ operation_id: string; operation_json: string }>('SELECT operation_id,operation_json FROM native_widget_completion_intents ORDER BY rowid LIMIT 1000');
    const result: WidgetCompletionOperation[] = [];
    const rejected: typeof rows = [];
    for (const row of rows) try {
      if (row.operation_json.length > 24_000) throw new Error('ウィジェット操作の容量を確認できません。');
      const operation = validateWidgetCompletionOperation(JSON.parse(row.operation_json));
      if (operation.id !== row.operation_id) throw new Error('ウィジェット操作の保存位置が一致しません。');
      result.push(operation);
    } catch {
      rejected.push(row);
    }
    // Preserve exact input and compare-and-delete, without a native transaction per broken row.
    for (let offset = 0; offset < rejected.length; offset += 100) {
      const page = rejected.slice(offset, offset + 100);
      await withIsolatedSqliteTransaction(database, async tx => {
        await tx.runAsync(`INSERT OR IGNORE INTO widget_rejected_inputs VALUES${page.map(() => '(?,?,?)').join(',')}`,
          ...page.flatMap(row => [sharedDocumentDigest({ json: row.operation_json }), row.operation_json, 'invalidInput']));
        await tx.runAsync(`DELETE FROM native_widget_completion_intents WHERE (operation_id,operation_json) IN (VALUES${page.map(() => '(?,?)').join(',')})`,
          ...page.flatMap(row => [row.operation_id, row.operation_json]));
      });
    }
    return result;
  });
}
