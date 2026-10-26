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
  '@marmeon/auth DeviceCookie.options.maxAge',
  '@marmeon/auth/two-factor TwoFactorMiddlewareOptions.maxAge',
  '@marmeon/cache Cache.ttl',
  '@marmeon/cache RateLimiter.availableIn',
  '@marmeon/notifications NotificationQueueOptions.backoff',
  '@marmeon/notifications SendQueuedNotification.backoff',
  '@marmeon/queue JobContext.once(options).for',
  '@marmeon/queue JobMiddlewareContext.timeout',
  '@marmeon/queue JobStatics.backoff',
  '@marmeon/queue JobStatics.timeout',
  '@marmeon/queue QueueConnections.worker(stopTimeout)',
  '@marmeon/queue WithoutOverlappingOptions.expiresAfter',
  '@marmeon/queue WithoutOverlappingOptions.releaseAfter',
  '@marmeon/queue WorkOptions.maxTime',
  '@marmeon/queue WorkOptions.sleep',
  '@marmeon/queue WorkOptions.stopTimeout',
  '@marmeon/auth AuthConfig.emailChangeThrottle',
  '@marmeon/auth AuthConfig.passwordTimeout',
  '@marmeon/auth AuthConfig.resetExpire',
  '@marmeon/auth AuthConfig.resetThrottle',
  '@marmeon/auth AuthServiceProvider.config.emailChangeThrottle',
  '@marmeon/auth AuthServiceProvider.config.passwordTimeout',
  '@marmeon/auth AuthServiceProvider.config.resetExpire',
  '@marmeon/auth AuthServiceProvider.config.resetThrottle',
  '@marmeon/session SessionConfig.lifetime',
  '@marmeon/session SessionServiceProvider.config.lifetime',
]);
