/** A driver's package is missing, or a cache driver of a provider breaks its contract: what to do, said at startup (the CLI prints it without a stack trace). */
export class CacheSetupError extends Error {
  override name = 'CacheSetupError';
}
