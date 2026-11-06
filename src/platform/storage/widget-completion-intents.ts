import type { SQLiteDatabase } from 'expo-sqlite';
import { validateWidgetCompletionOperation } from '../../features/widgets/completion-operation.ts';
import type { WidgetCompletionOperation } from '../../features/widgets/completion-operation.ts';
import { withPlannerDatabaseOperation } from './repository.ts';

/** Read a bounded native input queue. No completion, calendar, or Google state is changed here. */
export function readNativeWidgetCompletionOperations(database: SQLiteDatabase): Promise<WidgetCompletionOperation[]> {
  return withPlannerDatabaseOperation(database, async () => {
    if (!await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE name='native_widget_completion_intents'")) return [];
    const rows = await database.getAllAsync<{ operation_id: string; operation_json: string }>('SELECT operation_id,operation_json FROM native_widget_completion_intents ORDER BY rowid LIMIT 1000');
    return rows.map(row => {
      if (row.operation_json.length > 24_000) throw new Error('ウィジェット操作の容量を確認できません。');
      const operation = validateWidgetCompletionOperation(JSON.parse(row.operation_json));
      if (operation.id !== row.operation_id) throw new Error('ウィジェット操作の保存位置が一致しません。');
      return operation;
    });
  });
}
