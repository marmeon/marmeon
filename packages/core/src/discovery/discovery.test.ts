import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Container } from '../container.ts';
import { registerProviders } from '../provider.ts';
import type { Key } from '../token.ts';
import { generateManifest, loadDiscoveredPackages } from './discover.ts';
import { resolveExports, runtimeConditions, splitSpecifier, type PackageInfo } from './resolve.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures/discovery');
const corePackage = join(here, '../..');
const tsc = join(here, '../../../../node_modules/.bin/tsc');

const DEV = ['@bespokecore/source', ...runtimeConditions([], '')];
const PROD = runtimeConditions([], '');

/**
 * Lays packages out like pnpm does: each lives in its own store directory, and
 * only declared dependencies are linked next to it. The app therefore cannot
 * import @acme/clock — only @acme/mailer can.
 */
function createFixtureApp(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bespoke-discovery-')));
  const store = (name: string) => join(root, 'store', name, 'node_modules', '@acme', name.replace('acme-', ''));
  const link = (target: string, at: string) => {
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(target, at, 'dir');
  };

  for (const name of ['acme-clock', 'acme-mailer', 'acme-source']) {
    cpSync(join(fixtures, name), store(name), { recursive: true });
    cpSync(join(fixtures, 'tsconfig.package.json'), join(store(name), 'tsconfig.json'));
  }
  link(store('acme-clock'), join(root, 'store/acme-mailer/node_modules/@acme/clock'));

  // Built with plain tsc, like any third-party package — no BespokeCore tooling.
  for (const name of ['acme-clock', 'acme-mailer', 'acme-source']) execFileSync(tsc, ['-p', store(name)]);

  const app = join(root, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: { '@acme/mailer': '1.0.0', '@acme/source': '1.0.0', '@bespokecore/core': '*' } }),
  );
  link(store('acme-mailer'), join(app, 'node_modules/@acme/mailer'));
  link(store('acme-source'), join(app, 'node_modules/@acme/source'));
  link(corePackage, join(app, 'node_modules/@bespokecore/core'));
  cpSync(join(fixtures, 'main.ts'), join(app, 'main.ts'));
  return app;
}

describe('bespoke discover', () => {
  let app: string;
  beforeAll(() => {
    app = createFixtureApp();
  }, 60_000);
  afterAll(() => rmSync(dirname(app), { recursive: true, force: true }));

  const run = () =>
    JSON.parse(
      execFileSync(process.execPath, ['--conditions=@bespokecore/source', join(app, 'main.ts')], { cwd: app, encoding: 'utf8' }),
    );

  it('makes classes of installed packages injectable and registers their providers', () => {
    const result = run();

    // Clock comes from @acme/clock, which the app itself cannot even import.
    expect(result.sent).toBe('SMTP → ada@example.com at 09:00');
    expect(result.retries).toBe(3); // optional parameter left to its default
    expect(result.fake).toBe('fake → bob@example.com at 09:00'); // subpath export
    expect(result.greeting).toBe('SMTP → Grace at noon'); // default export
    expect(result.packages).toEqual(['@acme/clock', '@acme/mailer']); // dependencies first
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

  it('leaves packages that resolve to TypeScript sources to the load hook', () => {
    expect(generateManifest({ root: app, conditions: DEV }).summary.packages).not.toContain('@acme/source');
    expect(generateManifest({ root: app, conditions: PROD }).summary.packages).toContain('@acme/source');
  });

  it('records absolute module URLs and resolved dependencies in the manifest', () => {
    const { manifest, summary } = generateManifest({ root: app, conditions: DEV });
    const ref = ([module, name]: readonly [number, string]) => `${manifest.modules[module]!.replace(/^.*\/store\//, '')}#${name}`;
    const smtp = manifest.injections.find((entry) => entry.class[1] === 'SmtpMailer')!;

    expect(manifest.modules[0]).toMatch(/^file:\/\/\/.*\/store\/acme-clock\/node_modules\/@acme\/clock\/dist\/index\.js$/);
    expect('inject' in smtp && smtp.inject.map(ref)).toEqual([
      'acme-clock/node_modules/@acme/clock/dist/index.js#Clock',
      'acme-mailer/node_modules/@acme/mailer/dist/index.js#Formatter',
    ]);
    expect(summary).toMatchObject({ injectable: 3, unresolvable: 1, providers: 2 });
  });

  it('works in-process too, e.g. inside Vitest', async () => {
    const discovered = await loadDiscoveredPackages({ root: app, conditions: DEV, force: true });
    const container = new Container();
    registerProviders(container, discovered.providers);

    const mailer = (await import(pathToFileURL(join(app, 'node_modules/@acme/mailer/dist/index.js')).href)) as {
      Mailer: Key<{ send(to: string): string }>;
    };
    expect(container.make(mailer.Mailer).send('ada@example.com')).toBe('SMTP → ada@example.com at 09:00');
  });
});

describe('exports resolution', () => {
  const pkg = (exports: unknown): PackageInfo => ({ name: 'x', dir: '/pkg', json: { exports } });

  it('follows the object key order, like Node', () => {
    const exports = { '.': { '@bespokecore/source': './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' } };
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
