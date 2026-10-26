/**
 * The exceptions to "a span of time is a `Duration`, or its unit is in its name" that `pnpm api:check` enforces (`scripts/api.ts`;
 * the rule: docs/time.md, "Spans of time"). A key is the entry point and the path to the member: `<entry> <Declaration>.<member>`,
 * `<entry> <Declaration>.<method>(<parameter>)` for a parameter.
 */

/** The end of a name that marks a span of time. */
export const SPAN_WORDS: readonly string[] = [
  'timeout',
  'ttl',
  'delay',
  'backoff',
  'maxAge',
  'lifetime',
  'expire',
  'expires',
  'expiresIn',
  'expiresAfter',
  'releaseAfter',
  'interval',
  'throttle',
  'grace',
  'sleep',
  'wait',
  'debounce',
  'cacheFor',
  'poll',
  'maxTime',
  'uniqueFor',
  'availableIn',
  'for',
  'within',
];

/** Members that end in a span word and hold a bare number on purpose. Each says why; nothing else belongs here. */
export const SPAN_EXCEPTIONS: Readonly<Record<string, string>> = {
  '@marmeon/auth/passkeys PublicKeyCredentialCreationOptionsJSON.timeout': 'milliseconds, as the WebAuthn JSON defines them',
  '@marmeon/auth/passkeys PublicKeyCredentialRequestOptionsJSON.timeout': 'milliseconds, as the WebAuthn JSON defines them',
  '@marmeon/auth DeviceCookie.options.maxAge': "seconds, the cookie's Max-Age; handed to cookies.set as it is",
  '@marmeon/cache CacheEntry.expires': 'a point in time, epoch milliseconds',
  '@marmeon/cache CacheStore.increment(expires)': 'a point in time, epoch milliseconds',
  '@marmeon/cache LockStore.lock(expires)': 'a point in time, epoch milliseconds',
  '@marmeon/queue JobRecord.backoff': 'a field of the stored job record: seconds, and it changes only with a format version',
  '@marmeon/queue UniqueRecord.for': 'a field of the stored job record: seconds, and it changes only with a format version',
};

/**
 * Spans that do not follow the rule yet. Each change that fixes one deletes its line; the list is empty before a release.
 */
export const SPAN_PENDING: ReadonlySet<string> = new Set<string>([
]);
