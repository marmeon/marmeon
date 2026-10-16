import { createApplication } from '@marmeon/core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { Storage, StorageServiceProvider } from './index.ts';

// @marmeon/http is an optional peer: an app without it still gets disks. Its import fails the way a missing package does.
vi.mock('./http-modules.ts', () => ({
  loadHttpModules: async () => {
    throw Object.assign(new Error("Cannot find package '@marmeon/http' imported from storage"), { code: 'ERR_MODULE_NOT_FOUND' });
  },
}));

afterAll(removeDirectories);

describe('storage without @marmeon/http installed', () => {
  it('starts, serves its disks and says what is missing for temporary URLs', async () => {
    const app = await createApplication({ root: freshDirectory(), discover: false, providers: [StorageServiceProvider] }, { env: { LOG_LEVEL: 'silent' } });
    const disk = app.container.make(Storage).disk('local');
    await disk.put('a.txt', 'hi');
    expect(await disk.text('a.txt')).toBe('hi');
    await expect(disk.temporaryUrl('a.txt', { expiresIn: 60 })).rejects.toThrow('needs @marmeon/http');
  });
});
