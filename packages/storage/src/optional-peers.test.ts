import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { runWithHook, writeMissingHook } from './__fixtures__/missing-packages.ts';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  exports: Record<string, Record<string, string>>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};
const optional = Object.entries(manifest.peerDependenciesMeta)
  .filter(([, meta]) => meta.optional)
  .map(([name]) => name);
const entries = Object.entries(manifest.exports).map(([key, target]) => [key, resolve(root, target['@marmeon/source']!)] as const);

const directory = tempDir('marmeon-optional-peers-');
const hook = writeMissingHook(directory, optional);

/** Imports `target` in a fresh Node process in which every optional peer of storage is missing. */
function loadWithoutPeers(target: string): { status: number | null; stderr: string } {
  return runWithHook(hook, `await import(${JSON.stringify(target)}); process.exit(0);`);
}

/**
 * Boots Encryption, Database (SQLite in memory), Http and Storage in a child where `missing` is refused to modules under `from`, then
 * reports whether uploads are on or off with the message S2 gives. With nothing refused, uploads are on.
 */
function bootWithout(missing: readonly string[], from: string, { database = true } = {}): { status: number | null; stdout: string; stderr: string } {
  const refusing = writeMissingHook(directory, missing, from);
  return runWithHook(
    refusing,
    `
    const { createApplication } = await import('@marmeon/core');
    const { EncryptionServiceProvider, generateKey } = await import('@marmeon/encryption');
    const { HttpServiceProvider } = await import('@marmeon/http');
    const { DatabaseServiceProvider } = ${database ? "await import('@marmeon/database')" : '{}'};
    const { StorageServiceProvider } = await import(${JSON.stringify(pathToFileURL(resolve(root, 'src/index.ts')).href)});
    const { TemporaryUploads } = await import(${JSON.stringify(pathToFileURL(resolve(root, 'src/uploads/service.ts')).href)});
    const app = await createApplication(
      { root: ${JSON.stringify(directory)}, discover: false, providers: [EncryptionServiceProvider, ...(DatabaseServiceProvider ? [DatabaseServiceProvider] : []), HttpServiceProvider, StorageServiceProvider] },
      { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:' } },
    );
    try {
      app.container.make(TemporaryUploads);
      console.log('uploads on');
    } catch (error) {
      console.log('uploads off: ' + error.message);
    }
    await app.shutdown();
    process.exit(0);
    `,
  );
}

const STORAGE = '/packages/storage/src/';

describe('storage without its optional peers installed', () => {
  it('reads the optional peers and the source entries from package.json', () => {
    expect(optional).toContain('@marmeon/database');
    expect(entries.length).toBeGreaterThan(1);
  });

  it('refuses an optional peer under the hook, so the hook cannot pass by blocking nothing', () => {
    for (const name of ['@marmeon/database', '@marmeon/database/internal']) {
      const run = loadWithoutPeers(name);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('ERR_MODULE_NOT_FOUND');
    }
  });

  it.each(entries)('the entry "%s" of @marmeon/storage loads with every optional peer missing', (_key, entry) => {
    const run = loadWithoutPeers(pathToFileURL(entry).href);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('boots with uploads on when nothing is refused, so the cases below judge the refusal', () => {
    const run = bootWithout([], STORAGE);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('uploads on');
    expect(run.stdout).not.toContain('refused');
  });

  it.each(['@marmeon/database', '@marmeon/encryption'])('boots without %s and says what uploads need', (name) => {
    const run = bootWithout([name], STORAGE);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`refused ${name}`);
    expect(run.stdout).toContain('uploads off: [marmeon:S2] Uploads need @marmeon/http, @marmeon/database and @marmeon/encryption');
  });

  it('stops the boot when @marmeon/database is installed but one of its own dependencies is missing', () => {
    // The query builder that the database package loads first (named at run time: only that package may name it in source).
    const dependency = ['kys', 'ely'].join('');
    const run = bootWithout([dependency], '/packages/database/', { database: false });
    expect(run.stdout).toContain(`refused ${dependency}`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`Cannot find package '${dependency}'`);
    expect(run.stdout).not.toContain('uploads');
  });
});
