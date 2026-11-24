import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, cpSync, existsSync, mkdirSync, statSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { createApplication } from '../application.ts';
import type { Key } from '../token.ts';
import { combineDigests, DiscoveryError, fileDigest, generateManifest, loadDiscoveredPackages, manifestPath, marmeonField, writeManifest } from './discover.ts';
import { findPackage, printable, resolveExports, runtimeConditions, splitSpecifier, type PackageInfo } from './resolve.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures/discovery');
const corePackage = join(here, '../..');
const tsc = join(here, '../../../../node_modules/.bin/tsc');

const DEV = ['@marmeon/source', ...runtimeConditions([], '')];
const PROD = runtimeConditions([], '');

/**
 * Lays packages out like pnpm does: each lives in its own store directory, and
 * only declared dependencies are linked next to it. The app therefore cannot
 * import @acme/clock — only @acme/mailer can.
 */
function createFixtureApp(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-discovery-')));
  // @acme/source plays a workspace package: linked from outside node_modules, like pnpm
  // does for workspace:* — the only place where Node strips types of a dependency.
  const store = (name: string) =>
    name === 'acme-source'
      ? join(root, 'workspace', name)
      : join(root, 'store', name, 'node_modules', '@acme', name.replace('acme-', ''));
  const link = (target: string, at: string) => {
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(target, at, 'dir');
  };

  for (const name of ['acme-clock', 'acme-mailer', 'acme-source']) {
    cpSync(join(fixtures, name), store(name), { recursive: true });
    cpSync(join(fixtures, 'tsconfig.package.json'), join(store(name), 'tsconfig.json'));
  }
  link(store('acme-clock'), join(root, 'store/acme-mailer/node_modules/@acme/clock'));

  // Built with plain tsc, like any third-party package — no Marmeon tooling.
  for (const name of ['acme-clock', 'acme-mailer', 'acme-source']) execFileSync(tsc, ['-p', store(name)]);

  const app = join(root, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: { '@acme/mailer': '1.0.0', '@acme/source': '1.0.0', '@marmeon/core': '*' } }),
  );
  link(store('acme-mailer'), join(app, 'node_modules/@acme/mailer'));
  link(store('acme-source'), join(app, 'node_modules/@acme/source'));
  link(corePackage, join(app, 'node_modules/@marmeon/core'));
  // The fixture is no file of the core's sources, which alone may import `@marmeon/core/internal`: it names a placeholder instead.
  writeFileSync(join(app, 'main.ts'), readFileSync(join(fixtures, 'main.ts'), 'utf8').replace("'the-core-internals'", "'@marmeon/core/internal'"));
  return app;
}

describe('discovery errors', () => {
  it('a DiscoveryError carries its code', () => {
    let thrown: unknown;
    try {
      throw new DiscoveryError('@acme/mailer lists provider "X" in package.json, but its entry does not export it.');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toMatch(/^\[marmeon:K7\] @acme\/mailer lists provider/);
  });
});

describe('the manifest and a .marmeon that links out of the app', () => {
  it('refuses to write through the link, naming the path inside the app', async () => {
    const root = tempDir('marmeon-manifest-link-');
    const outside = tempDir('marmeon-manifest-link-outside-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
    symlinkSync(outside, join(root, '.marmeon'), 'dir');
    let message = '';
    try {
      writeManifest({ root, conditions: DEV });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^\.marmeon leads out of the app.*Nothing was written\.$/);
    expect(message).not.toContain(root);
    expect(readdirSync(outside)).toEqual([]);
    await expect(loadDiscoveredPackages({ root, conditions: DEV })).rejects.toThrow(/\.marmeon leads out of the app/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses to read a current manifest through the link, and imports nothing it lists', async () => {
    const root = tempDir('marmeon-manifest-read-');
    const outside = tempDir('marmeon-manifest-read-outside-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
    writeManifest({ root, conditions: DEV });
    // The manifest as a planted one would be: current (its hash fits the app), but listing a provider whose import leaves a mark.
    const planted = join(outside, 'manifest.source.json');
    renameSync(join(root, '.marmeon'), `${outside}-moved`);
    symlinkSync(outside, join(root, '.marmeon'), 'dir');
    const marker = join(outside, 'imported');
    writeFileSync(join(outside, 'evil.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); export class Evil {}\n`);
    const current = JSON.parse(readFileSync(join(`${outside}-moved`, 'manifest.source.json'), 'utf8'));
    writeFileSync(planted, JSON.stringify({ ...current, modules: [join(outside, 'evil.mjs')], providers: [[0, 'Evil']] }));
    onTestFinished(() => rmSync(`${outside}-moved`, { recursive: true, force: true }));

    await expect(loadDiscoveredPackages({ root, conditions: DEV })).rejects.toThrow(/^\.marmeon leads out of the app, so \.marmeon\/manifest\.source\.json was not read\./);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(outside).sort()).toEqual(['evil.mjs', 'manifest.source.json']);
  });

  it('refuses to read a manifest that is itself a link to an outside file, and imports nothing it lists', async () => {
    const root = tempDir('marmeon-manifest-file-');
    const outside = tempDir('marmeon-manifest-file-outside-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
    writeManifest({ root, conditions: DEV });
    const file = join(root, '.marmeon', 'manifest.source.json');
    const current = JSON.parse(readFileSync(file, 'utf8'));
    const marker = join(outside, 'imported');
    writeFileSync(join(outside, 'evil.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); export class Evil {}\n`);
    writeFileSync(join(outside, 'planted.json'), JSON.stringify({ ...current, modules: [join(outside, 'evil.mjs')], providers: [[0, 'Evil']] }));
    rmSync(file);
    symlinkSync(join(outside, 'planted.json'), file);

    await expect(loadDiscoveredPackages({ root, conditions: DEV })).rejects.toThrow(/^\.marmeon\/manifest\.source\.json leads out of the app, so \.marmeon\/manifest\.source\.json was not read\./);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a manifest that is a dangling link to an outside path, and replaces one that points inside the app', async () => {
    const root = tempDir('marmeon-manifest-dangling-');
    const outside = tempDir('marmeon-manifest-dangling-outside-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
    mkdirSync(join(root, '.marmeon'));
    const file = join(root, '.marmeon', 'manifest.source.json');
    symlinkSync(join(outside, 'nowhere.json'), file);
    await expect(loadDiscoveredPackages({ root, conditions: DEV })).rejects.toThrow(/was not read\./);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(file);
    symlinkSync(join(root, 'nowhere.json'), file);
    await expect(loadDiscoveredPackages({ root, conditions: DEV })).resolves.toBeDefined();
  });

  it('allows a .marmeon that links to a directory inside the app', () => {
    const root = tempDir('marmeon-manifest-link-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
    mkdirSync(join(root, 'cache'));
    symlinkSync(join(root, 'cache'), join(root, '.marmeon'), 'dir');
    writeManifest({ root, conditions: DEV });
    expect(readdirSync(join(root, 'cache')).length).toBe(1);
  });
});

describe('marmeon discover', () => {
  let app: string;
  beforeAll(() => {
    app = createFixtureApp();
  }, 60_000);
  afterAll(() => rmSync(dirname(app), { recursive: true, force: true }));

  const run = () =>
    JSON.parse(
      execFileSync(process.execPath, ['--conditions=@marmeon/source', join(app, 'main.ts')], { cwd: app, encoding: 'utf8' }),
    );

  it('makes classes of installed packages injectable and registers their providers', () => {
    const result = run();

    // Clock comes from @acme/clock, which the app itself cannot even import.
    expect(result.sent).toBe('SMTP → ada@example.com at 09:00');
    expect(result.retries).toBe(3); // optional parameter left to its default
    expect(result.fake).toBe('fake → bob@example.com at 09:00'); // subpath export
    expect(result.greeting).toBe('SMTP → Grace at noon'); // default export
    expect(result.packages).toEqual(['@acme/clock', '@acme/mailer', '@acme/source']); // dependencies first
  });

  it('explains value objects instead of failing discovery', () => {
    expect(run().money).toMatch(
      /\[Money\] needs 2 constructor argument\(s\) but has no injection list\. Cannot inject @acme\/mailer\/dist\/money\.d\.ts:\d+ — Money, parameter "amount: number"/,
    );
  });

  it('regenerates the manifest only when dependencies change', () => {
    run(); // settle
    expect(run().regenerated).toBe(false);

    const json = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ ...json, description: 'changed' }));
    expect(run().regenerated).toBe(true);
  });

  it('records only the providers of packages that resolve to TypeScript sources', () => {
    const dev = generateManifest({ root: app, conditions: DEV }).manifest;
    const prod = generateManifest({ root: app, conditions: PROD }).manifest;
    const sourceModules = (manifest: typeof dev) => manifest.modules.filter((url) => url.includes('acme-source'));

    // In development the load hook injects TypeScript sources; the provider still registers,
    // from the very URL the runtime resolves to.
    expect(sourceModules(dev)).toEqual([expect.stringMatching(/\/src\/index\.ts$/)]);
    expect(sourceModules(prod)).toEqual([expect.stringMatching(/\/dist\/index\.js$/)]);
    expect(dev.providers.map(([, name]) => name)).toContain('SourceServiceProvider');
  });

  it('records module paths relative to the app and resolved dependencies in the manifest', () => {
    const { manifest, summary } = generateManifest({ root: app, conditions: DEV });
    const ref = ([module, name]: readonly [number, string]) => `${manifest.modules[module]!.replace(/^.*\/store\//, '')}#${name}`;
    const smtp = manifest.injections.find((entry) => entry.class[1] === 'SmtpMailer')!;

    expect(manifest.modules[0]).toBe('../store/acme-clock/node_modules/@acme/clock/dist/index.js');
    expect(manifest.modules.filter((path) => path.startsWith('/') || path.startsWith('file:'))).toEqual([]);
    expect('inject' in smtp && smtp.inject.map(ref)).toEqual([
      'acme-clock/node_modules/@acme/clock/dist/index.js#Clock',
      'acme-mailer/node_modules/@acme/mailer/dist/index.js#Formatter',
    ]);
    expect(summary).toMatchObject({ injectable: 3, unresolvable: 1, providers: 3 });
  });

  it('lists only the modules whose classes it injects — a subpath for an optional peer that is not installed is never imported at boot', () => {
    const { manifest } = generateManifest({ root: app, conditions: PROD });
    expect(manifest.modules.filter((path) => path.endsWith('/optional.js')), 'a subpath without a class to inject is listed — imported at boot').toEqual([]);
    // The app starts: nothing imports @acme/optional-peer.
    expect(run().sent).toBe('SMTP → ada@example.com at 09:00');
  });

  it('regenerates atomically — processes racing to rewrite the manifest never read half a file', async () => {
    // The dev server, `marmeon` commands and test workers all regenerate after `pnpm add`.
    writeFileSync(
      join(app, 'race.ts'),
      `import { loadDiscoveredPackages } from '@marmeon/core/internal';
       let failures = 0;
       for (let i = 0; i < 25; i++) {
         try { await loadDiscoveredPackages({ root: import.meta.dirname, force: true }); } catch { failures++; }
       }
       console.log(failures);`,
    );
    const race = () =>
      promisify(execFile)(process.execPath, ['--conditions=@marmeon/source', join(app, 'race.ts')], { cwd: app, encoding: 'utf8' });
    const results = await Promise.all([race(), race(), race(), race()]);

    expect(results.map(({ stdout }) => stdout.trim())).toEqual(['0', '0', '0', '0']);
    expect(readdirSync(join(app, '.marmeon')).filter((name) => name.endsWith('.tmp'))).toEqual([]); // no temporary files left behind
  }, 30_000);

  it('discovers again when a listed package is gone but package.json and the lockfile stayed — a production install without dev dependencies', async () => {
    writeFileSync(
      join(app, 'packages.ts'),
      `import { loadDiscoveredPackages } from '@marmeon/core/internal';
       const { packages, regenerated } = await loadDiscoveredPackages({ root: import.meta.dirname });
       console.log(JSON.stringify({ packages, regenerated }));`,
    );
    const packages = () => JSON.parse(execFileSync(process.execPath, ['--conditions=@marmeon/source', join(app, 'packages.ts')], { cwd: app, encoding: 'utf8' })) as { packages: string[]; regenerated: boolean };
    expect(packages().packages).toContain('@acme/source');
    // `pnpm install --prod`: the dev dependency's link and files are gone, package.json and the lockfile are the same.
    const workspace = join(dirname(app), 'workspace', 'acme-source');
    const link = join(app, 'node_modules/@acme/source');
    renameSync(workspace, `${workspace}-gone`);
    rmSync(link);
    try {
      expect(packages()).toEqual({ packages: ['@acme/clock', '@acme/mailer'], regenerated: true });
    } finally {
      renameSync(`${workspace}-gone`, workspace);
      symlinkSync(workspace, link, 'dir');
    }
  });

  it('keeps one manifest per set of conditions — switching between the monorepo source and the published dist rewrites nothing', async () => {
    const mtime = (name: string) => statSync(join(app, '.marmeon', name)).mtimeMs;
    await loadDiscoveredPackages({ root: app, conditions: DEV });
    await loadDiscoveredPackages({ root: app, conditions: PROD });
    const before = { source: mtime('manifest.source.json'), published: mtime('manifest.json') };
    // `marmeon dev` → `marmeon start` → `marmeon dev`: each finds its own file up to date.
    expect((await loadDiscoveredPackages({ root: app, conditions: DEV })).regenerated).toBe(false);
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(false);
    expect({ source: mtime('manifest.source.json'), published: mtime('manifest.json') }).toEqual(before);
    expect(manifestPath(app, [...PROD, 'edge-light'])).toBe(join(app, '.marmeon', 'manifest.edge-light.json'));
  });

  it('discovers in memory when .marmeon/ is read-only and the manifest is out of date — with one warning, never EACCES', async () => {
    await loadDiscoveredPackages({ root: app, conditions: PROD, force: true });
    const file = join(app, '.marmeon', 'manifest.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/"hash": "\w+"/, '"hash": "outdated"'));
    const outdated = readFileSync(file, 'utf8');
    chmodSync(join(app, '.marmeon'), 0o555);
    chmodSync(file, 0o444);
    try {
      const first = await loadDiscoveredPackages({ root: app, conditions: PROD });
      expect(first).toMatchObject({ regenerated: true, packages: ['@acme/clock', '@acme/mailer', '@acme/source'] });
      expect(first.warning).toMatch(/^\.marmeon\/manifest\.json is out of date and \.marmeon\/ cannot be written \(EACCES\): the packages were discovered in memory/);
      // Once per process — the next app of this process discovers in memory again, silently.
      const second = await loadDiscoveredPackages({ root: app, conditions: PROD });
      expect(second.regenerated).toBe(true);
      expect(second.warning).toBeUndefined();
      expect(readFileSync(file, 'utf8')).toBe(outdated);
    } finally {
      chmodSync(join(app, '.marmeon'), 0o755);
      chmodSync(file, 0o644);
    }
    // Writable again: written as usual.
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(true);
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(false);
  });

  it('works in-process too, e.g. inside Vitest', async () => {
    await loadDiscoveredPackages({ root: app, conditions: DEV, force: true });
    const { container } = await createApplication({ root: app });

    const mailer = (await import(pathToFileURL(join(app, 'node_modules/@acme/mailer/dist/index.js')).href)) as {
      Mailer: Key<{ send(to: string): string }>;
    };
    expect(container.make(mailer.Mailer).send('ada@example.com')).toBe('SMTP → ada@example.com at 09:00');
  });
});

describe('the manifest and the package.json of a package in the workspace', () => {
  interface Layout {
    /** Where the app lies in the temporary folder `top`, which holds `root` (the workspace candidate) and what lies beside it. */
    readonly app?: string;
    /** Files made empty, relative to `top`. */
    readonly files?: readonly string[];
    /** The linked package has no `marmeon` field until `write` adds one. */
    readonly plain?: boolean;
  }

  /** An app with one package linked from `place` (relative to the app). */
  function linkedApp(place: string, { app: appPath = 'app', files = [], plain = false }: Layout = {}) {
    const top = realpathSync(tempDir('marmeon-sources-'));
    const app = join(top, appPath);
    const dir = join(app, place);
    mkdirSync(app, { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (const file of files) {
      mkdirSync(dirname(join(top, file)), { recursive: true });
      writeFileSync(join(top, file), '');
    }
    writeFileSync(join(dir, 'src/index.ts'), 'export class First {}\nexport class Second {}\n');
    const write = (provider?: string) =>
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: '@acme/linked', type: 'module', exports: { '.': './src/index.ts' }, ...(provider === undefined ? {} : { marmeon: { providers: [provider] } }) }),
      );
    write(plain ? undefined : 'First');
    writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@acme/linked': 'link:./linked' } }));
    mkdirSync(join(app, 'node_modules/@acme'), { recursive: true });
    symlinkSync(dir, join(app, 'node_modules/@acme/linked'), 'dir');
    const manifestFile = manifestPath(app, PROD);
    const read = (file = manifestFile) => JSON.parse(readFileSync(file, 'utf8')) as { sources: string[]; sourcesHash: string; providers: [number, string][] };
    return { top, app, dir, write, manifestFile, manifest: () => read() };
  }

  it('writes the manifest again when the package.json of a linked package changes', async () => {
    const { app, write, manifest } = linkedApp('linked');
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(true);
    expect(manifest().sources).toEqual(['linked/package.json']);
    expect(manifest().providers.map(([, name]) => name)).toEqual(['First']);
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(false);

    write('Second');
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(true);
    expect(manifest().providers.map(([, name]) => name)).toEqual(['Second']);
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(false);
  });

  it('does not list a package outside the workspace, so two boots in a row write once', async () => {
    const { app, manifest } = linkedApp('../elsewhere');
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(true);
    expect(manifest().sources).toEqual([]);
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(false);
  });

  it('regenerates a manifest whose sources name another file than a package.json, and does not read it', async () => {
    const { app, manifestFile, manifest } = linkedApp('linked');
    await loadDiscoveredPackages({ root: app, conditions: PROD });
    const secret = join(app, 'secret.txt');
    writeFileSync(secret, 'secret');
    // The hash a reader would get from the file's bytes: had it been read, the manifest would count as fresh and nothing would be regenerated.
    const bytes = combineDigests([fileDigest(readFileSync(secret))]);
    writeFileSync(manifestFile, JSON.stringify({ ...manifest(), sources: ['secret.txt'], sourcesHash: bytes }));
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(true);
    expect(manifest().sources).toEqual(['linked/package.json']);
  });

  it('regenerates a manifest whose sources name a package.json that links out of the workspace, and does not read it', async () => {
    const { app, manifestFile, manifest } = linkedApp('linked');
    await loadDiscoveredPackages({ root: app, conditions: PROD });
    const outside = join(dirname(app), 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'package.json'), '{"name":"outside"}');
    mkdirSync(join(app, 'leak'));
    symlinkSync(join(outside, 'package.json'), join(app, 'leak/package.json'));
    const bytes = combineDigests([fileDigest(readFileSync(join(outside, 'package.json')))]);
    writeFileSync(manifestFile, JSON.stringify({ ...manifest(), sources: ['leak/package.json'], sourcesHash: bytes }));
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(true);
    expect(manifest().sources).toEqual(['linked/package.json']);
  });

  it('lists the packages of a monorepo outside the app, by the lockfile at its root, and not one beside it', async () => {
    const layout = { app: 'root/apps/app', files: ['root/pnpm-lock.yaml'] };
    const inside = linkedApp('../../packages/linked', layout);
    expect((await loadDiscoveredPackages({ root: inside.app, conditions: PROD })).regenerated).toBe(true);
    expect(inside.manifest().sources).toEqual(['../../packages/linked/package.json']);
    expect((await loadDiscoveredPackages({ root: inside.app, conditions: PROD })).regenerated).toBe(false);
    inside.write('Second');
    expect((await loadDiscoveredPackages({ root: inside.app, conditions: PROD })).regenerated).toBe(true);
    expect(inside.manifest().providers.map(([, name]) => name)).toEqual(['Second']);

    const beside = linkedApp('../../../beside', layout);
    expect((await loadDiscoveredPackages({ root: beside.app, conditions: PROD })).regenerated).toBe(true);
    expect(beside.manifest().sources).toEqual([]);
    expect((await loadDiscoveredPackages({ root: beside.app, conditions: PROD })).regenerated).toBe(false);
  });

  it('takes the folder with pnpm-workspace.yaml as the workspace, though the app has a lockfile of its own', async () => {
    const { app, manifest } = linkedApp('../../packages/linked', { app: 'root/apps/app', files: ['root/pnpm-workspace.yaml', 'root/apps/app/pnpm-lock.yaml'] });
    await loadDiscoveredPackages({ root: app, conditions: PROD });
    expect(manifest().sources).toEqual(['../../packages/linked/package.json']);
  });

  it('takes the folder of a package.json with workspaces as the workspace', async () => {
    const { top, app, manifest } = linkedApp('../../packages/linked', { app: 'root/apps/app' });
    writeFileSync(join(top, 'root/package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
    await loadDiscoveredPackages({ root: app, conditions: PROD });
    expect(manifest().sources).toEqual(['../../packages/linked/package.json']);
  });

  it('lists a workspace package without a marmeon field, and loads its provider once it names one', async () => {
    const { app, write, manifest } = linkedApp('linked', { plain: true });
    const first = await loadDiscoveredPackages({ root: app, conditions: PROD });
    expect(first.providers).toEqual([]);
    expect(manifest().sources).toEqual(['linked/package.json']);

    write('Second');
    const second = await loadDiscoveredPackages({ root: app, conditions: PROD });
    expect(second.regenerated).toBe(true);
    expect(second.providers.map((provider) => provider.name)).toEqual(['Second']);
  });

  it('regenerates when a listed package.json is deleted', async () => {
    const { app, dir } = linkedApp('linked');
    await loadDiscoveredPackages({ root: app, conditions: PROD });
    rmSync(join(dir, 'package.json'));
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(true);
  });

  it('regenerates a manifest of the previous version, whatever its sources say', async () => {
    const { app, manifestFile, manifest } = linkedApp('linked');
    await loadDiscoveredPackages({ root: app, conditions: PROD });
    writeFileSync(manifestFile, JSON.stringify({ ...manifest(), version: '3' }));
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(true);
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(false);
  });

  it('lists the packages of an app reached through a symlinked folder', async () => {
    const { top, app, write } = linkedApp('linked');
    const through = join(top, 'through');
    symlinkSync(app, through, 'dir');
    await loadDiscoveredPackages({ root: through, conditions: PROD });
    const file = manifestPath(through, PROD);
    expect(JSON.parse(readFileSync(file, 'utf8')).sources).toEqual([expect.stringMatching(/linked\/package\.json$/)]);
    expect((await loadDiscoveredPackages({ root: through, conditions: PROD })).regenerated).toBe(false);
    // The same app by its real path: the entries read alike, so nothing is written again.
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(false);
    write('Second');
    expect((await loadDiscoveredPackages({ root: through, conditions: PROD })).regenerated).toBe(true);
  });

  it('regenerates a manifest that has no sources, however fresh its hash is', async () => {
    const { app, manifestFile, manifest } = linkedApp('linked');
    await loadDiscoveredPackages({ root: app, conditions: PROD });
    const { sources: _sources, sourcesHash: _hash, ...old } = manifest();
    writeFileSync(manifestFile, JSON.stringify(old));
    expect((await loadDiscoveredPackages({ root: app, conditions: PROD })).regenerated).toBe(true);
  });
});

describe('peer dependencies', () => {
  /**
   * A workspace like this repository's: @acme/kit (a dev dependency of the app, e.g. a testing package) has @acme/extra as a
   * peer — and its own node_modules link @acme/extra too, because kit's tests use it. An installed kit would not have that link:
   * a peer is what the package depending on kit provides. Discovered only when the app has it.
   */
  function workspace(appHasExtra: boolean): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-peers-')));
    const write = (dir: string, json: object) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
    };
    write(join(root, 'packages/kit'), { name: '@acme/kit', version: '1.0.0', peerDependencies: { '@acme/extra': '*' }, marmeon: {} });
    write(join(root, 'packages/extra'), { name: '@acme/extra', version: '1.0.0', marmeon: {} });
    mkdirSync(join(root, 'packages/kit/node_modules/@acme'), { recursive: true });
    symlinkSync(join(root, 'packages/extra'), join(root, 'packages/kit/node_modules/@acme/extra'), 'dir');
    const app = join(root, 'apps/app');
    write(app, { name: 'app', type: 'module', devDependencies: { '@acme/kit': '*', ...(appHasExtra ? { '@acme/extra': '*' } : {}) } });
    mkdirSync(join(app, 'node_modules/@acme'), { recursive: true });
    symlinkSync(join(root, 'packages/kit'), join(app, 'node_modules/@acme/kit'), 'dir');
    if (appHasExtra) symlinkSync(join(root, 'packages/extra'), join(app, 'node_modules/@acme/extra'), 'dir');
    return app;
  }

  it("resolves a package's peers from the package that depends on it — not from links of the peer's own dev dependencies", () => {
    for (const [hasExtra, expected] of [[false, ['@acme/kit']], [true, ['@acme/extra', '@acme/kit']]] as const) {
      const app = workspace(hasExtra);
      try {
        expect(generateManifest({ root: app, conditions: DEV }).summary.packages).toEqual(expected);
      } finally {
        rmSync(join(app, '../..'), { recursive: true, force: true });
      }
    }
  });
});

describe('exports resolution', () => {
  const pkg = (exports: unknown): PackageInfo => ({ name: 'x', dir: '/pkg', json: { exports } });

  it('follows the object key order, like Node', () => {
    const exports = { '.': { '@marmeon/source': './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' } };
    expect(resolveExports(pkg(exports), '.', DEV)).toBe('/pkg/src/index.ts');
    expect(resolveExports(pkg(exports), '.', PROD)).toBe('/pkg/dist/index.js');
  });

  it('resolves ESM-only packages that only offer the "import" condition', () => {
    expect(resolveExports(pkg({ '.': { import: './index.js' } }), '.', PROD)).toBe('/pkg/index.js');
    expect(resolveExports(pkg({ '.': { require: './index.cjs' } }), '.', PROD)).toBeUndefined();
  });

  it('reads the conditions of the running process', () => {
    expect(runtimeConditions(['--conditions=a', '-C', 'b'], '--conditions c')).toEqual([
      'a', 'b', 'c', 'node', 'import', 'module-sync', 'node-addons',
    ]);
    expect(splitSpecifier('@acme/mailer/testing')).toEqual({ name: '@acme/mailer', subpath: './testing' });
  });
});

describe('the "marmeon" field of a package', () => {
  const field = (marmeon: unknown, raw?: string): PackageInfo => ({
    name: '@acme/marmeon-audit',
    dir: '/x',
    json: (raw === undefined ? { name: '@acme/marmeon-audit', marmeon } : JSON.parse(raw)) as PackageInfo['json'],
  });
  const messageOf = (pkg: PackageInfo) => {
    try {
      marmeonField(pkg);
    } catch (error) {
      expect(error).toBeInstanceOf(DiscoveryError);
      return (error as Error).message;
    }
    return undefined;
  };

  it('accepts what the protocol lists, and a package without the field', () => {
    expect(marmeonField(field({ providers: ['AuditServiceProvider'], browser: ['src/client/**'], experimental: true }))?.providers).toEqual(['AuditServiceProvider']);
    expect(marmeonField(field({ experimental: ['./table'] }))?.providers).toEqual([]);
    expect(marmeonField(field({}))?.providers).toEqual([]);
    expect(marmeonField(field(undefined, '{"name":"x"}'))).toBeUndefined();
  });

  it('does not refuse serverModules in a dependency: the key is the app\'s own and ignored here', () => {
    expect(marmeonField(field({ providers: ['A'], serverModules: ['modules/billing/invoices/**'] }))?.providers).toEqual(['A']);
  });

  it('refuses a key it does not know, naming the package, the key and the known keys — a misspelt "provider" is not ignored', () => {
    expect(messageOf(field({ provider: ['AuditServiceProvider'] }))).toBe(
      '[marmeon:K7] @acme/marmeon-audit has an unknown key "provider" in its "marmeon" field (known: providers, browser, experimental, serverModules, namespace, entry, views, lang) — a misspelt key would leave its providers out.',
    );
    expect(messageOf(field({ providers: ['A'], migrations: 'stubs' }))).toContain('unknown key "migrations"');
  });

  it('refuses a field that is no object', () => {
    for (const [value, kind] of [[['A'], 'an array'], ['AuditServiceProvider', 'a string'], [null, 'null'], [true, 'a boolean'], [0, 'a number'], [false, 'a boolean']] as const) {
      expect(messageOf(field(value)), JSON.stringify(value)).toContain(`but it is ${kind}, not an object`);
    }
  });

  it('refuses providers that are no list of class names, and browser that is no list of strings', () => {
    for (const providers of ['AuditServiceProvider', ['a-b'], [1], [null], ['A', ''], { 0: 'A' }, ['A.B'], ['A\nB']]) {
      expect(messageOf(field({ providers })), JSON.stringify(providers)).toContain('"providers" is not a list of class names');
    }
    for (const browser of ['src/**', [1], [['src/**']], null, {}]) {
      expect(messageOf(field({ browser })), JSON.stringify(browser)).toContain('"browser" is not a list of globs');
    }
  });

  it('reads __proto__ and constructor as keys of the field, not as members of an object: unknown', () => {
    expect(messageOf(field(undefined, '{"marmeon":{"__proto__":{"providers":["Evil"]}}}'))).toContain('unknown key "__proto__"');
    expect(messageOf(field(undefined, '{"marmeon":{"constructor":{"prototype":{}}}}'))).toContain('unknown key "constructor"');
    expect(messageOf(field(undefined, '{"marmeon":{"providers":["A"],"__proto__":null}}'))).toContain('unknown key "__proto__"');
    expect(messageOf(field(undefined, '{"marmeon":{"__proto__":{}}}'))).toContain('unknown key "__proto__"');
    // nothing of the field reached Object.prototype
    expect(({} as { providers?: unknown }).providers).toBeUndefined();
  });

  it('never repeats a value, and a key only when it looks like an identifier', () => {
    const secret = 'TOKEN=hunter2';
    expect(messageOf(field({ [secret]: secret }))).not.toContain('hunter2');
    expect(messageOf(field({ [secret]: secret }))).toContain('a key that is not an identifier (not shown)');
    expect(messageOf(field({ 'x\u001b]8;;https://evil.test\u0007': 1 }))).not.toMatch(/[\p{Cc}\p{Cf}]|evil/u);
    expect(messageOf(field({ [`a${'b'.repeat(200)}`]: 1 }))).not.toContain('bbbb');
    expect(messageOf(field({ providers: ['https://evil.test/hunter2'] }))).not.toContain('hunter2');
    expect(messageOf(field({ browser: [{ token: 'hunter2' }] }))).not.toContain('hunter2');
    expect(messageOf(field({ extra: { token: 'hunter2' } }))).not.toContain('hunter2');
  });

  it('refuses an experimental that is neither true nor a list of strings', () => {
    for (const experimental of [42, 'yes', false, null, [1], {}]) {
      expect(messageOf(field({ experimental })), JSON.stringify(experimental)).toContain('"experimental" is neither true nor a list');
    }
  });

  it('reads only own properties of the field and of the dependency lists — a polluted Object.prototype supplies nothing', () => {
    const root = tempDir('marmeon-polluted-');
    const write = (dir: string, json: object) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
    };
    write(root, { name: 'app', type: 'module' });
    write(join(root, 'node_modules/@acme/loaded'), { name: '@acme/loaded', version: '1.0.0', marmeon: {} });
    const prototype = Object.prototype as Record<string, unknown>;
    prototype.providers = ['Evil'];
    prototype.browser = 'x';
    prototype.experimental = 42;
    prototype.dependencies = { '@acme/loaded': '*' };
    try {
      expect(marmeonField(field({}))?.providers).toEqual([]);
      expect(generateManifest({ root, conditions: DEV }).summary.packages).toEqual([]);
    } finally {
      delete prototype.providers;
      delete prototype.browser;
      delete prototype.experimental;
      delete prototype.dependencies;
    }
  });

  it('reads a large or deep field without recursing into it', () => {
    const many = Object.fromEntries(Array.from({ length: 200_000 }, (_, index) => [`key${index}`, index]));
    expect(messageOf(field(many))).toContain('unknown key "key0"');
    let deep: unknown = 'leaf';
    for (let level = 0; level < 5_000; level++) deep = { next: deep };
    expect(messageOf(field({ providers: ['A'], extra: deep }))).toContain('unknown key "extra"');
    expect(messageOf(field({ providers: deep }))).toContain('"providers" is not a list');
    expect(messageOf(field({ experimental: deep }))).toContain('"experimental" is neither');
    expect(marmeonField(field({ providers: Array.from({ length: 100_000 }, () => 'A') }))?.providers).toHaveLength(100_000);
  });

  it('stops discovery of the app, with the package named, before anything is written', () => {
    const root = tempDir('marmeon-field-');
    const write = (dir: string, json: object) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
    };
    write(root, { name: 'app', type: 'module', dependencies: { '@acme/marmeon-audit': '1.0.0' } });
    write(join(root, 'node_modules/@acme/marmeon-audit'), { name: '@acme/marmeon-audit', version: '1.0.0', marmeon: { provider: ['AuditServiceProvider'] } });
    expect(() => generateManifest({ root, conditions: DEV })).toThrow(/^\[marmeon:K7\] @acme\/marmeon-audit has an unknown key "provider"/);
    expect(() => writeManifest({ root, conditions: DEV })).toThrow(DiscoveryError);
    expect(existsSync(join(root, '.marmeon'))).toBe(false);
  });
});

describe('findPackage', () => {
  const root = tempDir('marmeon-find-package-');
  mkdirSync(join(root, 'node_modules/@acme/ok'), { recursive: true });
  writeFileSync(join(root, 'node_modules/@acme/ok/package.json'), '{"name":"@acme/ok"}');
  mkdirSync(join(root, 'node_modules/broken'), { recursive: true });
  writeFileSync(join(root, 'node_modules/broken/package.json'), '{ not json');
  mkdirSync(join(root, 'elsewhere'), { recursive: true });
  writeFileSync(join(root, 'elsewhere/package.json'), '{"name":"elsewhere"}');

  it('finds a package by its name', () => {
    expect(findPackage('@acme/ok', root)?.json.name).toBe('@acme/ok');
  });

  it('finds an older package name with capitals', () => {
    mkdirSync(join(root, 'node_modules/JSONStream'), { recursive: true });
    writeFileSync(join(root, 'node_modules/JSONStream/package.json'), '{"name":"JSONStream"}');
    expect(findPackage('JSONStream', root)?.name).toBe('JSONStream');
  });

  it('stops with the package and the path when its package.json is no JSON', () => {
    expect(() => findPackage('broken', root)).toThrow(/^\[marmeon:K7\] The package.json of broken \(.*broken[\\/]package.json\) cannot be read as JSON/);
  });

  it('writes control characters of a broken package.json as escapes in the message', () => {
    mkdirSync(join(root, 'node_modules/hostile'), { recursive: true });
    writeFileSync(join(root, 'node_modules/hostile/package.json'), 'x\u001b]8;;https://evil.test\u0007\u202e');
    let message = '';
    try {
      findPackage('hostile', root);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('[marmeon:K7]');
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(printable('a\u001b[2Jb‮c ')).toBe('a\\u001b[2Jb\\u202ec\\u2028');
  });

  it('stops with the package when its package.json is JSON but no object', () => {
    for (const [name, text] of [['json-null', 'null'], ['json-array', '[]'], ['json-string', '"x"'], ['json-number', '1']] as const) {
      mkdirSync(join(root, 'node_modules', name), { recursive: true });
      writeFileSync(join(root, 'node_modules', name, 'package.json'), text);
      expect(() => findPackage(name, root), text).toThrow(new RegExp(`^\\[marmeon:K7\\] The package.json of ${name} \\(.*\\) is not a JSON object\\.$`));
    }
  });

  it('finds nothing for a name that is a path', () => {
    expect(findPackage('../elsewhere', join(root, 'node_modules/@acme'))).toBeUndefined();
    expect(findPackage('@acme/../../elsewhere', root)).toBeUndefined();
    expect(findPackage('/abs', root)).toBeUndefined();
  });
});

describe('a hostile package.json and its declarations', () => {
  /** An app depending on `hostile`, whose files are `files` (paths in the package) next to its `json`; `outside.js` lies next to the app. */
  const appWith = (json: object, files: Record<string, string> = {}, dependencies: unknown = { hostile: '1.0.0' }) => {
    const root = tempDir('marmeon-hostile-');
    const app = join(root, 'app');
    const dir = join(app, 'node_modules/hostile');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', type: 'module', dependencies }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'hostile', version: '1.0.0', marmeon: {}, ...json }));
    writeFileSync(join(root, 'outside.js'), 'export class Outside {}\n');
    writeFileSync(join(root, 'outside.d.ts'), 'export declare class Outside {}\n');
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    return { root, app, dir };
  };
  const refusal = /^\[marmeon:K7\] hostile names an entry in its package\.json .* outside the package\.$/;
  const classes = { 'index.js': 'export class A {}\n', 'index.d.ts': 'export declare class A {}\n' };

  it('refuses an entry outside the package: "main", "exports", "types" and an absolute path', () => {
    for (const json of [
      { main: '../../outside.js' },
      { exports: '../../outside.js' },
      { exports: { '.': { import: './../../../outside.js' } } },
      { exports: { '.': './index.js', './x': '../../outside.js' } },
      { main: './index.js', types: '../../outside.d.ts' },
    ]) {
      const { app } = appWith(json, classes);
      expect(() => generateManifest({ root: app, conditions: PROD }), JSON.stringify(json)).toThrow(refusal);
    }
    const { root, app } = appWith({}, classes);
    writeFileSync(join(app, 'node_modules/hostile/package.json'), JSON.stringify({ name: 'hostile', marmeon: {}, main: join(root, 'outside.js') }));
    expect(() => generateManifest({ root: app, conditions: PROD })).toThrow(refusal);
  });

  it('refuses an entry that is a symlink out of the package, and names no path', () => {
    const { root, app, dir } = appWith({ main: './index.js' });
    symlinkSync(join(root, 'outside.js'), join(dir, 'index.js'));
    writeFileSync(join(dir, 'index.d.ts'), 'export declare class Outside {}\n');
    expect(() => generateManifest({ root: app, conditions: PROD })).toThrow(refusal);
    expect(() => generateManifest({ root: app, conditions: PROD })).not.toThrow(/outside\.js/);
  });

  it('refuses a dangling link out of the package, as the entry or as a directory above it', () => {
    const file = appWith({ main: './index.js' });
    symlinkSync(join(file.root, 'missing.js'), join(file.dir, 'index.js'));
    expect(() => generateManifest({ root: file.app, conditions: PROD })).toThrow(refusal);
    const directory = appWith({ main: './dist/index.js' });
    symlinkSync(join(directory.root, 'missing'), join(directory.dir, 'dist'));
    expect(() => generateManifest({ root: directory.app, conditions: PROD })).toThrow(refusal);
  });

  it('still reads a package whose entry lies in it, or does not exist yet', () => {
    const { app } = appWith({ main: './index.js' }, classes);
    expect(generateManifest({ root: app, conditions: PROD }).summary.packages).toEqual(['hostile']);
    const missing = appWith({ main: './dist/index.js' });
    expect(generateManifest({ root: missing.app, conditions: PROD }).summary.packages).toEqual(['hostile']);
  });

  it('refuses an "exports" nested deeper than 32 levels with the package named, without a RangeError', () => {
    for (const nest of [(inner: unknown) => ({ import: inner }), (inner: unknown) => [inner]]) {
      let deep: unknown = './index.js';
      for (let level = 0; level < 20_000; level++) deep = nest(deep);
      const { app } = appWith({ exports: deep });
      expect(() => generateManifest({ root: app, conditions: PROD })).toThrow(/^\[marmeon:K7\] The "exports" of hostile nest deeper than 32 levels/);
    }
    let fine: unknown = './index.js';
    for (let level = 0; level < 30; level++) fine = { import: fine };
    expect(resolveExports({ name: 'x', dir: '/pkg', json: { exports: fine } }, '.', PROD)).toBe('/pkg/index.js');
  });

  it('writes text of a foreign .d.ts into a message with control characters escaped', () => {
    const { app } = appWith(
      { main: './index.js', types: './index.d.ts' },
      {
        'index.js': 'export class A {}\n',
        'index.d.ts': 'export declare class A {\n    constructor(x /* \u001b]8;;https://evil.test\u0007 \u202e */: Missing);\n}\n',
      },
    );
    const { manifest } = generateManifest({ root: app, conditions: PROD });
    const messages = manifest.injections.map((entry) => ('unresolvable' in entry ? entry.unresolvable : ''));
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(messages.join('\n')).toContain('\\u001b]8;;https://evil.test\\u0007');
  });

  it('writes a file name with control characters into a message escaped', () => {
    const { app } = appWith(
      { main: './index.js', types: './index.d.ts' },
      { 'index.js': 'export class A {}\n', 'index.d.ts': "export { A } from './a\u001b[2J.js';\n", 'a\u001b[2J.d.ts': 'export declare class A {\n    constructor(x: string);\n}\n' },
    );
    const { manifest } = generateManifest({ root: app, conditions: PROD });
    const message = manifest.injections.map((entry) => ('unresolvable' in entry ? entry.unresolvable : '')).join('\n');
    expect(message).toContain('a\\u001b[2J.d.ts');
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it('ignores "dependencies" that is no object, even as a 10 MB string', () => {
    for (const dependencies of ['x'.repeat(10_000_000), 42, true, ['a', 'b'], null]) {
      const { app } = appWith({}, {}, dependencies);
      expect(generateManifest({ root: app, conditions: PROD }).summary.packages).toEqual([]);
    }
  });

  describe('relative imports in its .d.ts files', () => {
    const outsideRefusal = /^\[marmeon:K7\] hostile imports "[^"]+" in its types, which lies outside the package\.$/;
    const entry = { main: './index.js', types: './index.d.ts' };
    const empty = 'export {};\n';

    it('are not followed out of the package', () => {
      for (const types of ["export * from '../../../outside.js';\n", "export { Outside } from '../../../outside.js';\n"]) {
        const { app } = appWith(entry, { 'index.js': empty, 'index.d.ts': types });
        expect(() => generateManifest({ root: app, conditions: PROD }), types).toThrow(outsideRefusal);
      }
    });

    it('are not followed through a symlink out of the package', () => {
      const directory = appWith(entry, { 'index.js': empty, 'index.d.ts': "export * from './link/outside.js';\n" });
      symlinkSync(directory.root, join(directory.dir, 'link'));
      expect(() => generateManifest({ root: directory.app, conditions: PROD })).toThrow(outsideRefusal);
      const file = appWith(entry, { 'index.js': empty, 'index.d.ts': "export * from './part.js';\n" });
      symlinkSync(join(file.root, 'outside.d.ts'), join(file.dir, 'part.d.ts'));
      expect(() => generateManifest({ root: file.app, conditions: PROD })).toThrow(outsideRefusal);
    });

    it('are not followed for a parameter type either: the class is unresolvable, and the file outside is not read', () => {
      const { root, app } = appWith(entry, {
        'index.js': 'export class A {}\n',
        'index.d.ts': "import { Outside } from '../../../outside.js';\nexport declare class A {\n    constructor(x: Outside);\n}\n",
      });
      chmodSync(join(root, 'outside.d.ts'), 0o000); // reading it would throw EACCES, not a DiscoveryError
      try {
        const { manifest } = generateManifest({ root: app, conditions: PROD });
        const messages = manifest.injections.map((item) => ('unresolvable' in item ? item.unresolvable : ''));
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(/hostile imports "\.\.\/\.\.\/\.\.\/outside\.js" in its types, which lies outside the package\./);
      } finally {
        chmodSync(join(root, 'outside.d.ts'), 0o644);
      }
    });

    it('name the specifier with control characters escaped', () => {
      const { app } = appWith(entry, { 'index.js': empty, 'index.d.ts': "export * from '../../../out\u001b[2Jside.js';\n" });
      expect(() => generateManifest({ root: app, conditions: PROD })).toThrow(/out\\u001b\[2Jside/);
    });

    it('stop at 64 levels of "export *" with a message, not a RangeError', () => {
      const files: Record<string, string> = { 'index.js': empty, 'index.d.ts': "export * from './f0.js';\n" };
      for (let index = 0; index < 10_000; index++) files[`f${index}.d.ts`] = `export * from './f${index + 1}.js';\n`;
      const { app } = appWith(entry, files);
      expect(() => generateManifest({ root: app, conditions: PROD })).toThrow(/^\[marmeon:K7\] hostile has re-exports nested deeper than 64 levels/);
    });

    it('may form a cycle, and a chain within the limit is read', () => {
      const cycle = appWith(entry, {
        'index.js': 'export class A {}\n',
        'index.d.ts': "export * from './a.js';\nexport declare class A {}\n",
        'a.d.ts': "export * from './b.js';\n",
        'b.d.ts': "export * from './a.js';\n",
      });
      expect(generateManifest({ root: cycle.app, conditions: PROD }).summary.packages).toEqual(['hostile']);
      const files: Record<string, string> = { 'index.js': 'export class A {}\n', 'index.d.ts': "export * from './f0.js';\n" };
      for (let index = 0; index < 60; index++) files[`f${index}.d.ts`] = `export * from './f${index + 1}.js';\n`;
      files['f60.d.ts'] = 'export declare class A {}\n';
      const chain = appWith(entry, files);
      expect(generateManifest({ root: chain.app, conditions: PROD }).summary.packages).toEqual(['hostile']);
    });
  });
});

describe('a module the test importer routed', () => {
  const IMPORTER = Symbol.for('marmeon.test.import');
  const registered = globalThis as Record<symbol, unknown>;
  const BUILT =
    'export class Dep {}\nexport class Solo {\n  constructor(dep) {\n    this.dep = dep;\n  }\n}\nexport class Other {\n  constructor(dep) {\n    this.dep = dep;\n  }\n}\nexport class SoloServiceProvider {\n  register() {}\n}\n';
  const DECLARATIONS =
    'export declare class Dep {}\nexport declare class Solo {\n  readonly dep: Dep;\n  constructor(dep: Dep);\n}\nexport declare class Other {\n  readonly dep: Dep;\n  constructor(dep: Dep);\n}\nexport declare class SoloServiceProvider {\n  register(): void;\n}\n';
  afterEach(() => {
    delete registered[IMPORTER];
  });

  /**
   * An app with one workspace package (linked from outside node_modules, built files with declarations) that has a provider and two injectable
   * classes; with `installed`, a package below node_modules whose class takes a dependency too.
   */
  function workspaceApp(installed = false): string {
    const root = realpathSync(tempDir('marmeon-routed-'));
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const manifest = (name: string, marmeon?: object) =>
      JSON.stringify({ name, version: '1.0.0', type: 'module', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } }, ...(marmeon ? { marmeon } : {}) });
    write('workspace/solo/package.json', manifest('@acme/solo', { providers: ['SoloServiceProvider'] }));
    write('workspace/solo/dist/index.d.ts', DECLARATIONS);
    write('workspace/solo/dist/index.js', BUILT);
    mkdirSync(join(root, 'node_modules/@acme'), { recursive: true });
    symlinkSync(join(root, 'workspace/solo'), join(root, 'node_modules/@acme/solo'), 'dir');
    const dependencies: Record<string, string> = { '@acme/solo': '1.0.0' };
    if (installed) {
      write('node_modules/@acme/inst/package.json', manifest('@acme/inst', {}));
      write('node_modules/@acme/inst/dist/index.d.ts', 'export declare class InstDep {}\nexport declare class Inst {\n  constructor(dep: InstDep);\n}\n');
      write('node_modules/@acme/inst/dist/index.js', 'export class InstDep {}\nexport class Inst {\n  constructor(dep) {\n    this.dep = dep;\n  }\n}\n');
      dependencies['@acme/inst'] = '1.0.0';
    }
    write('package.json', JSON.stringify({ type: 'module', dependencies }));
    return root;
  }

  /** The classes of a module a test's mock would answer with: new ones each time, as discovery attaches injection lists to them. */
  const classes = () => ({ Dep: class Dep {}, Solo: class Solo {}, Other: class Other {}, SoloServiceProvider: class SoloServiceProvider {} });
  const load = (root: string) => loadDiscoveredPackages({ root, conditions: PROD });
  const failureOf = (root: string) => load(root).then(() => undefined, (error: Error) => error);
  const injectOf = (target: unknown) => Object.hasOwn(target as object, 'inject');

  /** The manifest of the app as it is now, written by hand: loading it imports nothing, so a file can change afterwards without Node's copy. */
  function current(root: string, change: (manifest: { injections: unknown[] }) => void = () => undefined): void {
    const { manifest } = generateManifest({ root, conditions: PROD });
    change(manifest as unknown as { injections: unknown[] });
    mkdirSync(join(root, '.marmeon'), { recursive: true });
    writeFileSync(manifestPath(root, PROD), JSON.stringify(manifest));
  }

  it('boots what the importer answered with', async () => {
    const root = workspaceApp();
    const complete = classes();
    registered[IMPORTER] = async () => complete;
    expect((await load(root)).providers).toEqual([complete.SoloServiceProvider]);
    expect((complete.Solo as unknown as { inject: unknown[] }).inject).toEqual([complete.Dep]);
  });

  it('passes the rejection of the importer on, as it is', async () => {
    const root = workspaceApp();
    const failure = new Error('the test runner refused');
    registered[IMPORTER] = async () => {
      throw failure;
    };
    expect(await failureOf(root)).toBe(failure);
  });

  const missing: [string, string][] = [
    ['a provider', 'SoloServiceProvider'],
    ['an injection target', 'Solo'],
    ['an injected value', 'Dep'],
  ];
  for (const [name, export_] of missing) {
    it(`is a K7 naming the file and the export for ${name} the module lacks`, async () => {
      const root = workspaceApp();
      const module: Record<string, unknown> = classes();
      module[export_] = undefined;
      registered[IMPORTER] = async () => module;
      const failure = await failureOf(root);
      expect(failure).toBeInstanceOf(DiscoveryError);
      expect(failure!.message).toContain(`[marmeon:K7] workspace/solo/dist/index.js has no export "${export_}", which the app's packages need to boot. If a test mocks it, the mock must export it.`);
    });
  }

  for (const [name, value] of [['a string', 'nope'], ['null', null], ['an object', {}]] as const) {
    it(`is a K7 for a provider that is ${name}, which is no function`, async () => {
      const root = workspaceApp();
      registered[IMPORTER] = async () => ({ ...classes(), SoloServiceProvider: value });
      const failure = await failureOf(root);
      expect(failure).toBeInstanceOf(DiscoveryError);
      expect(failure!.message).toContain('workspace/solo/dist/index.js exports "SoloServiceProvider", which is no function, so it cannot be a service provider. If a test mocks it, the mock must export the provider class.');
    });
  }

  for (const [name, value] of [['null', null], ['a string', 'nope'], ['a number', 4]] as const) {
    it(`is a K7 for an injection target that is ${name}, and nothing is written for the targets before it`, async () => {
      const root = workspaceApp();
      const module = { ...classes(), Other: value };
      registered[IMPORTER] = async () => module;
      const failure = await failureOf(root);
      expect(failure).toBeInstanceOf(DiscoveryError);
      expect(failure!.message).toContain('workspace/solo/dist/index.js exports "Other", which is no object or function, so it cannot take an injection list.');
      expect(injectOf(module.Solo)).toBe(false);
    });
  }

  it('boots an object as an injection target: a class may be mocked as one', async () => {
    const root = workspaceApp();
    const target = {};
    const module = { ...classes(), Other: target };
    registered[IMPORTER] = async () => module;
    expect((await load(root)).providers).toEqual([module.SoloServiceProvider]);
    expect((target as { inject?: unknown[] }).inject).toEqual([module.Dep]);
  });

  it('keeps the once-per-process warning for a boot that is refused', async () => {
    const root = workspaceApp();
    // the app cannot write .marmeon: the packages are discovered in memory, with one warning
    chmodSync(root, 0o555);
    try {
      registered[IMPORTER] = async () => ({ ...classes(), SoloServiceProvider: null });
      expect(await failureOf(root)).toBeInstanceOf(DiscoveryError);
      registered[IMPORTER] = async () => classes();
      expect((await load(root)).warning).toMatch(/is out of date and \.marmeon\/ cannot be written/);
    } finally {
      chmodSync(root, 0o755);
    }
  });

  it('leaves a module installed below node_modules to Node: its missing export is still a TypeError, with an importer registered', async () => {
    const root = workspaceApp(true);
    current(root);
    writeFileSync(join(root, 'node_modules/@acme/inst/dist/index.js'), 'export class InstDep {}\n');
    registered[IMPORTER] = async () => classes();
    const failure = await failureOf(root);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(DiscoveryError);
  });

  it('does not take a directory named Node_Modules for a workspace package', async () => {
    const root = workspaceApp();
    // the whole app below a directory of that name: nothing is routed, the importer is never asked
    const asked = vi.fn(async () => classes());
    registered[IMPORTER] = asked;
    const inside = join(realpathSync(tempDir('marmeon-routed-upper-')), 'Node_Modules', 'app');
    mkdirSync(dirname(inside), { recursive: true });
    cpSync(root, inside, { recursive: true, verbatimSymlinks: false, dereference: false });
    rmSync(join(inside, 'node_modules/@acme/solo'));
    symlinkSync(join(inside, 'workspace/solo'), join(inside, 'node_modules/@acme/solo'), 'dir');
    expect((await load(inside)).providers).toHaveLength(1);
    expect(asked).not.toHaveBeenCalled();
  });

  it('boots without the importer when a class has a static getter `inject` that throws', async () => {
    const root = workspaceApp();
    writeFileSync(join(root, 'workspace/solo/dist/index.js'), `${BUILT}Object.defineProperty(Solo, 'inject', { get() { throw new Error('read'); }, configurable: true });\n`);
    expect((await load(root)).providers).toHaveLength(1);
  });

  it('is unchanged without the importer: a module that lacks an injection target ends in the TypeError it always did, no K7', async () => {
    const root = workspaceApp();
    current(root);
    writeFileSync(join(root, 'workspace/solo/dist/index.js'), 'export class Dep {}\nexport class Other {}\nexport class SoloServiceProvider {}\n');
    const failure = await failureOf(root);
    expect(failure).toBeInstanceOf(TypeError);
  });

  it('is unchanged without the importer: a provider the module lacks is returned as undefined', async () => {
    const root = workspaceApp();
    current(root, (manifest) => (manifest.injections = []));
    writeFileSync(join(root, 'workspace/solo/dist/index.js'), 'export class Dep {}\n');
    expect((await load(root)).providers).toEqual([undefined]);
  });
});
