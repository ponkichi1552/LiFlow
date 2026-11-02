const isolatedTargets = new WeakMap<object, (...args: unknown[]) => unknown>();

/** Copy data and read-only query closures without exposing their captured authority state.
 * Query callbacks receive copies too: a filter must not mutate a cached signed fact.
 */
export function isolatedProjectionValue<T>(input: T): T {
  const seen = new Map<object, unknown>();
  const copy = (value: unknown): unknown => {
    if (typeof value === 'function') {
      // Only unwrap our own pure copy boundary. User callbacks and authorization
      // wrappers remain intact; one input/output copy still protects captured data.
      const target = isolatedTargets.get(value) ?? value as (...args: unknown[]) => unknown;
      const wrapped = (...args: unknown[]) => isolatedProjectionValue(Reflect.apply(target, undefined, args.map(argument => isolatedProjectionValue(argument))));
      isolatedTargets.set(wrapped, target); return wrapped;
    }
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof Error) {
      const next = new Error(value.message); Object.setPrototypeOf(next, Object.getPrototypeOf(value)); seen.set(value, next);
      // V8 exposes its lazy native stack as an accessor. Materialize the error,
      // retaining its domain prototype/code without copying a live getter.
      for (const key of Reflect.ownKeys(value)) Object.defineProperty(next, key, {
        configurable: true, writable: true, enumerable: Object.getOwnPropertyDescriptor(value, key)!.enumerable,
        value: copy(Reflect.get(value, key)),
      });
      return next;
    }
    if (value instanceof Map) {
      const next = new Map(); seen.set(value, next);
      for (const [key, item] of value) next.set(copy(key), copy(item)); return next;
    }
    if (value instanceof Set) {
      const next = new Set(); seen.set(value, next); for (const item of value) next.add(copy(item)); return next;
    }
    if (Array.isArray(value)) { const next: unknown[] = []; seen.set(value, next); for (const item of value) next.push(copy(item)); return next; }
    const next = Object.create(Object.getPrototypeOf(value)); seen.set(value, next);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) throw new Error('Projection cache does not accept accessors');
      Object.defineProperty(next, key, { ...descriptor, value: copy(descriptor.value) });
    }
    return next;
  };
  return copy(input) as T;
}
