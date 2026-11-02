import type { SQLiteDatabase } from 'expo-sqlite';
import { createDeviceIdentity } from '../crypto.ts';
import type { SharingCryptoGateway } from '../crypto.ts';
import { createSharedRoster } from '../roster.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { initializeV2EventStore, createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import { v2GroupBootstrap } from '../v2/bootstrap.ts';
import { createV2GroupController } from '../v2/controller.ts';
import { chorePolicyFromPreset } from '../v2/model.ts';
import { createV2ScreenSession } from '../v2-ui/screen-session.ts';
import { addDays, localDateFromDate } from '../../../domain/scheduling/local-date.ts';
import { createV2PrivateTaskSource } from '../v2-ui/private-overlay.ts';

/** Local development fixture only. No registry, login, cloud, personal data or fabricated server receipts. */
export async function createV2DevelopmentPreview(input: {
  development: boolean; crypto: SharingCryptoGateway; makeId: () => string; now: () => Date;
  openDatabase: (userId: string, groupId: string) => Promise<{ database: SQLiteDatabase; close: () => Promise<void> }>;
  /** Optional, newly-created synthetic personal DB. Never the user's existing DB. */
  openPrivateDatabase?: (userId: string, groupId: string) => Promise<{ database: SQLiteDatabase; close: () => Promise<void> }>;
}) {
  if (!input.development) throw new Error('Development preview is unavailable');
  const token = input.makeId(); const groupId = `qa-v2-${token}`; const userId = `qa-v2-owner-${token}`; const householdId = 'qa-v2-isolated';
  const identity = await createDeviceIdentity(input.crypto); const roster = createSharedRoster(groupId, userId, identity, { schemaVersion: 2 });
  const opened = await input.openDatabase(userId, groupId); const database = opened.database;
  let privateOpened: Awaited<ReturnType<NonNullable<typeof input.openPrivateDatabase>>> | undefined; let closed = false;
  const close = async () => { closed = true; try { await privateOpened?.close(); } finally { await opened.close(); } };
  try {
    await initializeV2EventStore(database, { groupId, userId, householdId });
    const repository = createV2EventRepository(database, { groupId, userId, householdId, identity, anchor: roster, archive: () => [roster], now: input.now,
      assertWritable: () => { if (!input.development) throw new Error('Development preview is unavailable'); } });
    const controller = createV2GroupController(repository, { makeId: input.makeId, now: input.now,
      sync: async () => { throw new Error('このプレビューは端末内の検査専用です。クラウドへ送信しません。'); } });
    const today = sharedLocalDate(input.now(), 'Asia/Tokyo');
    await repository.commit(v2GroupBootstrap({ groupId, ownerUserId: userId, ownerDisplayName: '検査ユーザー', name: '開発用・端末内プレビュー',
      timeZone: 'Asia/Tokyo', anchorDate: today, kind: 'family' }));
    const plan = await controller.actions.readPlan({ from: today, through: today, asOfDate: today });
    for (const [id, preset, anchorDate, intervalDays] of [
      ['builtin-chore-08', 'common', today, 7], ['builtin-chore-07', 'eachMember', today, 7], ['builtin-chore-01', 'common', addDays(today, -7), 30],
    ] as const) {
      const chore = plan.chores.find((entry) => entry.id === `${groupId}.${id}`); if (!chore) throw new Error('開発用の家事を準備できませんでした。');
      await controller.actions.configureChore(chore.id, { policy: chorePolicyFromPreset(preset), anchorDate, intervalDays,
        windowBeforeDays: 2, windowAfterDays: 2, effectiveFrom: anchorDate, active: true });
    }
    let privateTasks;
    if (input.openPrivateDatabase) {
      privateOpened = await input.openPrivateDatabase(userId, `${groupId}-personal-fixture`);
      if (privateOpened.database === database || await privateOpened.database.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")) {
        throw new Error('個人家事の検査には空の独立した保存先が必要です。既存データは変更しません。');
      }
      const { initializeLocalDatabase, loadPlannerSnapshot, completeFirstSetup, updateChoreDefinition,
        readPersonalPlannerOverlaySnapshot, setPersonalDateTaskCompleted } = await import('../../../platform/storage/repository.ts');
      const privateDatabase = privateOpened.database; await initializeLocalDatabase(privateDatabase);
      const initial = await loadPlannerSnapshot(privateDatabase); const chore = initial.chores.find((entry) => entry.id === 'builtin-chore-08');
      if (!chore) throw new Error('検査用の個人家事を準備できませんでした。');
      await updateChoreDefinition(privateDatabase, { ...chore, name: '検査用の個人家事', description: '本人だけが見られる検査用の手順です。' });
      await completeFirstSetup(privateDatabase, { frequencyMode: 'balanced', restDays: [], enabledChoreIds: [chore.id],
        previousDates: { [chore.id]: { date: addDays(localDateFromDate(input.now()), -7) } }, weatherLocation: null });
      const assertAccess = () => { if (!input.development || closed) throw new Error('Development preview is unavailable'); };
      privateTasks = createV2PrivateTaskSource({ ownerUserId: userId, assertAccess,
        readSnapshot: async (instant) => ({ ownerUserId: userId, ...await readPersonalPlannerOverlaySnapshot(privateDatabase, instant) }),
        save: (command, guard) => setPersonalDateTaskCompleted(privateDatabase, command, guard) });
    }
    return { ...createV2ScreenSession({ controller, groupId, userId, now: input.now,
      privateTasks,
      // Explicit synthetic preferences, never the logged-in user's private settings or Calendar.
      readPreferences: () => ({ ownerUserId: userId, settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } }) }), close };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
export type V2DevelopmentPreview = Awaited<ReturnType<typeof createV2DevelopmentPreview>>;
export type V2DevelopmentPreviewModel = Awaited<ReturnType<V2DevelopmentPreview['readModel']>>;
