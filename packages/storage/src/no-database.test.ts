import { createApplication } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { StorageServiceProvider } from './index.ts';

// @marmeon/database is installed but fails to load (a broken install): not "absent", so the boot must not skip uploads silently.
vi.mock('@marmeon/database', () => {
  throw new Error('boom');
});

afterAll(removeDirectories);

describe('storage with an @marmeon/database that fails to load', () => {
  it('stops the boot with that error instead of treating it as absent', async () => {
    const start = createApplication({ root: freshDirectory(), discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, StorageServiceProvider] as never }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' } });
    // Vitest wraps what a mock factory throws and keeps the original as the cause.
    await expect(start).rejects.toMatchObject({ cause: { message: 'boom' } });
  });
});
