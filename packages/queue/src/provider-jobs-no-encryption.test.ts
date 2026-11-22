import { createApplication, Logger, type ServiceProviderClass } from '@marmeon/core';
import * as v from 'valibot';
import { expect, it, vi } from 'vitest';
import { silent } from './__fixtures__/targets.ts';
import type { QueueDriverFactory } from './driver.ts';
import { MemoryQueueDriver } from './drivers/memory.ts';
import { QueueServiceProvider } from './index.ts';

// An app without @marmeon/encryption installed. Vitest wraps an error thrown by a mock factory for a package, so the import
// itself cannot be made to fail like a missing package: this stands in for `importEncryption` with the message `importOptional`
// builds, and the test is about what the boot hands it.
vi.mock('./connections.ts', async (original) => ({
  ...(await original<typeof import('./connections.ts')>()),
  importEncryption: async (what = 'An encrypted job (static encrypted)') => {
    throw new Error(`[marmeon:Q4] ${what} needs @marmeon/encryption, which is not installed in this app`);
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
  expect((error as Error).message).toMatch(/^\[marmeon:Q4\] SecretJob \(pkg\.secret, provider SecretProvider\), an encrypted job \(static encrypted\), needs @marmeon\/encryption, which is not installed in this app/);
});
