import './typescript-loader.mjs';
import { createHouseholdChoreDefinitions } from '../../src/domain/chores/catalog.ts';

/** Explicit fixtures for the frozen Scheduler1/journal and paginated historical Tasks tests.
 * This never changes production initialization. The active catalogue/round contract
 * is exercised separately through personal-catalog-storage and personal-adaptive-repository. */
export async function installFrozenSchedulerFixture(database) {
  if (await database.getFirstAsync("SELECT id FROM chore_definitions WHERE id='builtin-chore-26'")) return;
  await database.withTransactionAsync(async () => {
    await database.runAsync("DELETE FROM chore_definitions WHERE household_id='local-household' AND id LIKE 'liflow-catalog-6.%'");
    for (const chore of createHouseholdChoreDefinitions('local-household')) {
      await database.runAsync('INSERT INTO chore_definitions VALUES(?,?,?,?,?)', chore.id, chore.householdId, chore.name, Number(chore.enabled), JSON.stringify(chore));
      await database.runAsync("INSERT INTO chore_state(chore_id,initial_pending,unknown_reason) VALUES(?,1,'unknown')", chore.id);
      await database.runAsync("INSERT INTO chore_assignments VALUES(?,'local-member')", chore.id);
    }
  });
}
