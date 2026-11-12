import { createApplication, defineModule, Logger, type LogContext } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const warnings: { message: string; context: LogContext }[] = [];
class Lines implements Logger {
  debug(): void {}
  info(): void {}
  warn(message: string, context: LogContext = {}): void {
    warnings.push({ message, context });
  }
  error(): void {}
  child(): Logger {
    return this;
  }
}

const first = openRoutes((Route) => void Route.get('/notes/:id', () => 'first'));
const second = openRoutes((Route) => void Route.get('/notes/:note', () => 'second'));

async function kernelFor(env: string) {
  vi.stubEnv('NODE_ENV', env);
  warnings.length = 0;
  const application = await createApplication(
    { root: import.meta.dirname, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider], modules: [defineModule({ name: 'a', routes: first }), defineModule({ name: 'b', routes: second })] },
    { env: { APP_KEY: generateKey(), NODE_ENV: env }, override: (container) => container.instance(Logger, new Lines()) },
  );
  return { application, kernel: createHttpKernel(application) };
}

describe('createHttpKernel — two routes with the same method and path', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('warns once in development, with H15 and both routes, and starts: the first one answers', async () => {
    const { application, kernel } = await kernelFor('development');
    const lines = warnings.filter((line) => line.message.includes('H15'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toContain('GET /notes/:note');
    expect(lines[0]!.message).toContain('GET /notes/:id');
    expect(await (await kernel.request('/notes/1')).text()).toBe('first');
    await application.shutdown();
  });

  it.each(['production', 'test'])('does not warn in %s, and starts the same', async (env) => {
    const { application, kernel } = await kernelFor(env);
    expect(warnings.filter((line) => line.message.includes('H15'))).toEqual([]);
    expect(await (await kernel.request('/notes/1')).text()).toBe('first');
    await application.shutdown();
  });
});
