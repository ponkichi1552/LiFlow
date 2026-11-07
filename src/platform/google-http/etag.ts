/** A conditional modification requires one exact strong provider version. */
export function isGoogleETag(value: unknown, maxLength = 1024): value is string {
  return typeof value === 'string' && value.length <= maxLength && /^"[\x21\x23-\x7E]+"$/u.test(value);
}
