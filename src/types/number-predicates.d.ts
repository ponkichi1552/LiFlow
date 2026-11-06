/**
 * Number.isInteger is true only for primitive numbers. Its standard library
 * signature does not narrow unknown/optional values. Preserve the published
 * shared Scheduler's source bytes while expressing that existing runtime guard.
 */
interface NumberConstructor {
  isInteger(number: unknown): number is number;
}
