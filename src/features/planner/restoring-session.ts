import type { V2GroupUiSession } from '../sharing/v2-ui/screen-session';

/** Presentation can be ready before verification. Commands always wait for a real, current session. */
export function createRestoringSessionGate() {
  let source: (() => Promise<V2GroupUiSession>) | undefined;
  let closed = false;
  let failure: Error | undefined;
  const waiting = new Set<{ resolve: (value: V2GroupUiSession) => void; reject: (error: Error) => void }>();
  const error = () => new Error('操作するアカウント・グループが変わりました。');
  const gate = {
    get(): Promise<V2GroupUiSession> {
      if (closed) return Promise.reject(error());
      if (failure) return Promise.reject(failure);
      if (source) return source().then(value => { if (closed) throw error(); return value; });
      return new Promise<V2GroupUiSession>((resolve, reject) => { waiting.add({ resolve, reject }); });
    },
    bind(next: () => Promise<V2GroupUiSession>) {
      if (closed) return;
      source = next; failure = undefined;
      for (const listener of waiting) void gate.get().then(listener.resolve, listener.reject);
      waiting.clear();
    },
    fail(cause: Error) { failure = cause; for (const listener of waiting) listener.reject(cause); waiting.clear(); },
    close() { closed = true; for (const listener of waiting) listener.reject(error()); waiting.clear(); source = undefined; },
  };
  return gate;
}

export function restoringDisplaySession(model: Awaited<ReturnType<V2GroupUiSession['readModel']>>, load: () => Promise<V2GroupUiSession>): V2GroupUiSession {
  const actions = new Proxy({} as V2GroupUiSession['controller']['actions'], {
    get: (_target, name) => typeof name !== 'string' || name === 'then' ? undefined : async (...args: unknown[]) => {
      const session = await load();
      const action = Object.hasOwn(session.controller.actions, name) ? session.controller.actions[name as keyof typeof session.controller.actions] : undefined;
      if (typeof action !== 'function') throw new Error('この操作を現在の状態で実行できません。');
      return Reflect.apply(action, session.controller.actions, args);
    },
  });
  return { groupId: model.plan.groupId, userId: model.viewerUserId,
    controller: { actions, sync: async () => (await load()).controller.sync(),
      readModel: async (...args) => (await load()).controller.readModel(...args) },
    readModel: async options => (await load()).readModel(options),
    privateTasks: { read: async (...args) => {
      const source = (await load()).privateTasks; if (!source) throw new Error('本人の家事を確認してください。'); return source.read(...args);
    }, setCompleted: async (...args) => {
      const source = (await load()).privateTasks; if (!source) throw new Error('本人の家事を確認してください。'); return source.setCompleted(...args);
    } },
  };
}
