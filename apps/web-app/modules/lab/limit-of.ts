import { RateLimiter } from '@marmeon/cache';
import type { TestApp } from '@marmeon/testing';

/** The attempts a lab limiter allows per window, read from the limiter the app registered: a test goes past it without a number of its own. */
export async function limitOf(app: TestApp, name: string): Promise<number> {
  const callback = app.container.make(RateLimiter).limiter(name);
  if (!callback) throw new Error(`No limiter named ${name}.`);
  const limits = [await callback({ ip: '127.0.0.1' } as never)].flat();
  return limits[0]!.maxAttempts;
}
