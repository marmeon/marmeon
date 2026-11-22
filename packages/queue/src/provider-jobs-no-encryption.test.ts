import { execFileSync } from 'node:child_process';
import { createApplication, Logger, type ServiceProviderClass } from '@marmeon/core';
import * as v from 'valibot';
import { expect, it, vi } from 'vitest';
import { silent } from './__fixtures__/targets.ts';
import type { QueueDriverFactory } from './driver.ts';
import { MemoryQueueDriver } from './drivers/memory.ts';
import { QueueServiceProvider } from './index.ts';

// An app without @marmeon/encryption installed. Vitest wraps an error thrown by a mock factory for a package, so the import
// itself cannot be made to fail like a missing package: this stands in for `importEncryption` and records what the boot hands it. The real
// words are held by the last test, in a process that cannot resolve the package.
vi.mock('./connections.ts', async (original) => ({
  ...(await original<typeof import('./connections.ts')>()),
  importEncryption: async (what?: string) => {
    throw new Error(`handed: ${what ?? '(nothing)'}`);
  },
}));

it("names the encrypted job and its provider when the encryption package is not installed", async () => {
  class SecretJob {
    static readonly job = 'pkg.secret';
    static readonly encrypted = true;
    static readonly schema = v.object({});
    handle(): void {}
  }
  const Provider = class {
    static jobs = [SecretJob];
  };
  Object.defineProperty(Provider, 'name', { value: 'SecretProvider' });
  const memory: QueueDriverFactory = ({ clock }) => ({ driver: new MemoryQueueDriver({ clock }), queue: 'default', retryAfterSeconds: 90 });
  const Driver = class {
    static queueDrivers = { 'memory-x': memory };
  };
  const error = await createApplication(
    { root: '/tmp', discover: false, providers: [QueueServiceProvider, Driver as unknown as ServiceProviderClass, Provider as unknown as ServiceProviderClass] },
    { env: { NODE_ENV: 'test', QUEUE_DRIVER: 'memory-x', QUEUE_FAILED_DRIVER: 'null' }, override: (container) => container.instance(Logger, silent) },
  ).catch((caught: unknown) => caught);
  expect((error as Error).message).toBe('handed: SecretJob (pkg.secret, provider SecretProvider), an encrypted job (static encrypted),');
});

it('hands nothing, for the default words, when the first encrypted job is a module\'s, also beside a provider\'s', async () => {
  class ModuleSecret {
    static readonly job = 'pkg.module-secret';
    static readonly encrypted = true;
    static readonly schema = v.object({});
    handle(): void {}
  }
  class ProviderSecret {
    static readonly job = 'pkg.provider-secret';
    static readonly encrypted = true;
    static readonly schema = v.object({});
    handle(): void {}
  }
  const Provider = class {
    static jobs = [ModuleSecret, ProviderSecret];
  };
  Object.defineProperty(Provider, 'name', { value: 'SecretProvider' });
  const error = await createApplication(
    { root: '/tmp', discover: false, providers: [QueueServiceProvider, Provider as unknown as ServiceProviderClass], modules: [{ name: 'billing', jobs: [ModuleSecret] }] },
    { env: { NODE_ENV: 'test', QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null' }, override: (container) => container.instance(Logger, silent) },
  ).catch((caught: unknown) => caught);
  expect((error as Error).message).toBe('handed: (nothing)');
});

it('says the released words, with the install line, where the package cannot be resolved', () => {
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@marmeon/encryption') throw Object.assign(new Error("Cannot find package '@marmeon/encryption'"), { code: 'ERR_MODULE_NOT_FOUND' });
      return next(specifier, context);
    } });
    const { importEncryption } = await import(${JSON.stringify(new URL('./connections.ts', import.meta.url).href)});
    await importEncryption().catch((error) => process.stdout.write(error.message));
  `;
  const said = execFileSync(process.execPath, ['--conditions=@marmeon/source', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  expect(said).toBe(
    '[marmeon:Q4] An encrypted job (static encrypted) needs @marmeon/encryption, which is not installed in this app: marmeon add encryption (or pnpm add -E @marmeon/encryption@<version of your app>)',
  );
}, 30_000);
