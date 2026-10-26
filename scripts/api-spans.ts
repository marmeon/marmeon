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
  '@marmeon/cache Limit.perDay(days)': "the unit is the method's own name (`perMinute(60, 5)` is 60 per 5 minutes), so the call shows it",
  '@marmeon/cache Limit.perHour(hours)': "the unit is the method's own name (`perMinute(60, 5)` is 60 per 5 minutes), so the call shows it",
  '@marmeon/cache Limit.perMinute(minutes)': "the unit is the method's own name (`perMinute(60, 5)` is 60 per 5 minutes), so the call shows it",
  '@marmeon/cache Limit.perSecond(seconds)': "the unit is the method's own name (`perMinute(60, 5)` is 60 per 5 minutes), so the call shows it",
  '@marmeon/queue JobRecord.backoff': 'a field of the stored job record: seconds, and it changes only with a format version',
  '@marmeon/queue UniqueRecord.for': 'a field of the stored job record: seconds, and it changes only with a format version',
  '@marmeon/auth AccessTokenStore.prune(graceSeconds)': 'a store contract an app can implement: it gets normalised numbers with the unit in the name (docs/time.md, rule 4)',
  '@marmeon/auth DatabaseAccessTokens.prune(graceSeconds)': "implements a store contract, so it takes the contract's number with its unit in the name (docs/time.md, rule 4)",
  '@marmeon/auth DatabasePasswordResetTokens.consume(maxAgeSeconds)': "implements a store contract, so it takes the contract's number with its unit in the name (docs/time.md, rule 4)",
  '@marmeon/auth DatabasePasswordResetTokens.create(throttleSeconds)': "implements a store contract, so it takes the contract's number with its unit in the name (docs/time.md, rule 4)",
  '@marmeon/auth DatabasePasswordResetTokens.prune(maxAgeSeconds)': "implements a store contract, so it takes the contract's number with its unit in the name (docs/time.md, rule 4)",
  '@marmeon/auth DatabaseSignIns.prune(rememberMaxAgeDays)': "implements a store contract, so it takes the contract's number with its unit in the name (docs/time.md, rule 4)",
  '@marmeon/auth PasswordResetTokenStore.consume(maxAgeSeconds)': 'a store contract an app can implement: it gets normalised numbers with the unit in the name (docs/time.md, rule 4)',
  '@marmeon/auth PasswordResetTokenStore.create(throttleSeconds)': 'a store contract an app can implement: it gets normalised numbers with the unit in the name (docs/time.md, rule 4)',
  '@marmeon/auth PasswordResetTokenStore.prune(maxAgeSeconds)': 'a store contract an app can implement: it gets normalised numbers with the unit in the name (docs/time.md, rule 4)',
  '@marmeon/auth SignInStore.prune(rememberMaxAgeDays)': 'a store contract an app can implement: it gets normalised numbers with the unit in the name (docs/time.md, rule 4)',
  '@marmeon/queue QueueDriver.push(delaySeconds)': 'a driver contract an app can implement: it gets normalised numbers with the unit in the name (docs/time.md, rule 4)',
  '@marmeon/queue QueueDriver.release(delaySeconds)': 'a driver contract an app can implement: it gets normalised numbers with the unit in the name (docs/time.md, rule 4)',
  '@marmeon/session SessionStore.gc(lifetimeSeconds)': 'a store contract an app can implement: it gets normalised numbers with the unit in the name (docs/time.md, rule 4)',
};
