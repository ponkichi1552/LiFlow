import type { SQLiteDatabase } from 'expo-sqlite';
import { inheritAdaptiveOwnerInputScope, assertCapturedAdaptiveOwnerInputs, withAdaptiveOwnerTransaction } from './adaptive-owner-inputs.ts';

/** Native transactions use their own connection so unrelated private writes cannot join them. */
export async function withIsolatedSqliteTransaction<T>(database: SQLiteDatabase, work: (transaction: SQLiteDatabase) => Promise<T>): Promise<T> {
  let result!: T;
  if (database.withExclusiveTransactionAsync) {
    await database.withExclusiveTransactionAsync(async (transaction) => { result = await inheritAdaptiveOwnerInputScope(database, transaction, async () => {
      const value = await work(transaction); await assertCapturedAdaptiveOwnerInputs(transaction); return value;
    }); });
  } else {
    await withAdaptiveOwnerTransaction(database, async () => { result = await work(database); });
  }
  return result;
}
