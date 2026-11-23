/** Only the API transport is simulated here. One local result stays readable by a different screen instance. */
export function applianceAnalysisScreenWork(run = async () => null) {
  const entries = new Map();
  const manuals = new Map();
  const key = (owner, { groupId, applianceId }) => JSON.stringify([owner, groupId, applianceId]);
  let sequence = 0;
  const source = {
    get: (owner, groupId, applianceId) => entries.get(key(owner, { groupId, applianceId })),
    setFocused: focused => { source.focused = focused; },
    focused: true,
  };
  async function startAnalysisWork(_database, { owner, target, request, filename, basis }) {
    const slot = key(owner, target);
    if (entries.get(slot)?.state === 'pending') return entries.get(slot).id;
    const id = `durable-screen-analysis-${++sequence}`;
    const entry = { id, ...target, filename, basis, manualDigest: id, state: 'pending', result: null };
    manuals.set(id, request.manual.base64);
    entries.set(slot, entry);
    void Promise.resolve().then(() => run(request)).then(result => {
      entries.set(slot, { ...entry, state: result?.status === 'verified' ? 'ready' : 'failed', result });
    });
    return id;
  }
  const hooks = {
    useTargetAnalysisWork: (_database, owner, groupId, applianceId, id) => {
      const work = source.get(owner, groupId, applianceId);
      return { value: work && (!id || work.id === id) ? work : null, focused: source.focused };
    },
    useAnalysisWorkList: (_database, owner, groupId) => ({ items: [...entries.entries()].filter(([scope]) => {
      const [uid, group] = JSON.parse(scope); return uid === owner && (!group || group === groupId);
    }).map(([, entry]) => entry) }),
  };
  const storage = { deviceAnalysisWork: () => ({
    async remove(owner, id) {
      for (const [slot, item] of entries) if (JSON.parse(slot)[0] === owner && item.id === id) entries.delete(slot);
    },
  }) };
  return { get: source.get, setFocused: source.setFocused, mocks: {
    '@/hooks/use-workspace': { useWorkspace: () => ({ userId: 'owner' }) },
    '@/platform/appliance-care/analysis-work': { startAnalysisWork },
    '../../../platform/appliance-care/analysis-work': { startAnalysisWork },
    '@/features/appliance-care/use-analysis-work': hooks,
    '../../appliance-care/use-analysis-work': hooks,
    '@/platform/storage/analysis-work': storage,
    '../../../platform/storage/analysis-work': storage,
    '../../../platform/storage/appliance-manuals': { readApplianceManual: async (_database, digest) => manuals.get(digest) ?? null },
  } };
}
