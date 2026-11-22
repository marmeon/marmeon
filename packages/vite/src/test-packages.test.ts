import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { testPackages } from './test-packages.ts';

const VIRTUAL = 'virtual:marmeon/test-packages';
const PREFIX = 'virtual:marmeon/test-package/';
const IMPORTER = Symbol.for('marmeon.test.import');
const encode = (url: string) => Buffer.from(url).toString('base64url');

interface Context {
  environment: { config: { consumer: 'client' | 'server'; resolve: { preserveSymlinks: boolean } } };
  error(message: string): never;
  resolve: ReturnType<typeof vi.fn>;
}
type Hooks = { resolveId(this: Context, id: string): Promise<unknown>; load(this: Context, id: string): unknown; configureVitest(context: { vitest: { version?: string } }): void };

/** The plugin with Vitest's version told, and a fake context for its hooks. */
function plugin(version: string | null = '5.1.1') {
  const hooks = testPackages() as unknown as Hooks;
  hooks.configureVitest({ vitest: version === null ? {} : { version } });
  const context = (consumer: 'client' | 'server' = 'server', resolved: unknown = null, preserveSymlinks = false): Context => ({
    environment: { config: { consumer, resolve: { preserveSymlinks } } },
    error: (message) => {
      throw new Error(message);
    },
    resolve: vi.fn(async () => resolved),
  });
  return { hooks, context };
}

/** The code the virtual module is, run with a recording `import`: the specifier the importer it registers asks for. */
function importerOf(code: string): (url: string) => unknown {
  new Function('__import', code.replace('import(', '__import('))((specifier: string) => specifier);
  return (globalThis as Record<symbol, unknown>)[IMPORTER] as (url: string) => unknown;
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[IMPORTER];
});

describe('the plugin', () => {
  it('changes no config: it has no hook that could, and it touches neither setup files nor Vitest', () => {
    const { hooks } = plugin();
    expect(Object.keys(hooks).sort()).toEqual(['configureVitest', 'enforce', 'load', 'name', 'resolveId']);
    expect((hooks as unknown as { enforce: string }).enforce).toBe('pre');
    const project = { config: { setupFiles: ['./setup.ts'] } };
    const vitest = Object.freeze({ version: '5.1.1' });
    (hooks.configureVitest as (context: unknown) => unknown)({ vitest, project });
    expect(project.config.setupFiles).toEqual(['./setup.ts']);
  });
});

describe('configureVitest', () => {
  for (const [name, context] of [['an empty context', {}], ['no context', undefined], ['no Vitest', { vitest: undefined }], ['a Vitest without a version', { vitest: {} }]] as const) {
    it(`does not throw for ${name}; the import then refuses, as the version is unknown`, () => {
      const { hooks, context: make } = plugin();
      expect(() => (hooks.configureVitest as (context?: unknown) => void)(context)).not.toThrow();
      expect(() => hooks.load.call(make(), `\0${VIRTUAL}`)).toThrow('its version is unknown here');
    });
  }
});

describe('the virtual module in a client environment (a simulated browser)', () => {
  it('only deletes the importer, whatever Vitest it is', async () => {
    for (const version of [null, '5.0.5', '5.1.1-beta.1']) {
      const { hooks, context } = plugin(version);
      (globalThis as Record<symbol, unknown>)[IMPORTER] = () => undefined;
      const code = hooks.load.call(context('client'), `\0${VIRTUAL}`) as string;
      expect(code).not.toContain('import(');
      new Function(code)();
      expect(IMPORTER in globalThis).toBe(false);
    }
  });

  it('resolves no prefixed id, so the client environment resolves no file of the machine', async () => {
    const { hooks, context } = plugin();
    const ctx = context('client', { id: '/etc/hosts', external: false });
    expect(await hooks.resolveId.call(ctx, `${PREFIX}${encode(pathToFileURL('/etc/hosts').href)}`)).toBeUndefined();
    expect(ctx.resolve).not.toHaveBeenCalled();
  });

  it('is the same for a real Vite server: its client environment resolves nothing, its server environment the file', async () => {
    const root = tempDir('marmeon-test-packages-');
    const outside = tempDir('marmeon-test-packages-outside-');
    writeFileSync(join(outside, 'thing.ts'), 'export const by = "outside";\n');
    const server = await createServer({ root, configFile: false, logLevel: 'silent', server: { middlewareMode: true, watch: null }, plugins: [testPackages()] });
    try {
      const id = `${PREFIX}${encode(pathToFileURL(join(outside, 'thing.ts')).href)}`;
      expect(await server.environments.client.pluginContainer.resolveId(id)).toBeNull();
      expect((await server.environments.ssr.pluginContainer.resolveId(id))?.id).toBe(join(await realOf(outside), 'thing.ts'));
    } finally {
      await server.close();
    }
  });
});

it('resolves a name with %23, a space or a non-ASCII character through the real server, to that very file', async () => {
  const root = tempDir('marmeon-test-packages-');
  const server = await createServer({ root, configFile: false, logLevel: 'silent', server: { middlewareMode: true, watch: null }, plugins: [testPackages()] });
  try {
    for (const name of ['a%23b.ts', 'with space.ts', 'ünï.ts']) {
      writeFileSync(join(root, name), 'export const by = "file";\n');
      const id = `${PREFIX}${encode(pathToFileURL(join(root, name)).href)}`;
      expect((await server.environments.ssr.pluginContainer.resolveId(id))?.id).toBe(join(await realOf(root), name));
    }
  } finally {
    await server.close();
  }
});

async function realOf(path: string): Promise<string> {
  return (await import('node:fs')).realpathSync.native(path);
}

describe('the virtual module in a server environment', () => {
  it('is one statement that registers an importer of the prefixed id, with the URL base64url encoded', () => {
    const { hooks, context } = plugin();
    const code = hooks.load.call(context(), `\0${VIRTUAL}`) as string;
    expect(code.split(';').filter((part) => part.trim())).toHaveLength(1);
    const url = pathToFileURL('/tmp/de ü/a#b%23.ts').href;
    expect(importerOf(code)(url)).toBe(`${PREFIX}${encode(url)}`);
  });

  it('is not loaded for another id', () => {
    const { hooks, context } = plugin();
    expect(hooks.load.call(context(), '/modules/a.ts')).toBeUndefined();
    expect(hooks.load.call(context(), VIRTUAL)).toBeUndefined();
  });

  it('resolves the id of the virtual module in every environment', async () => {
    const { hooks, context } = plugin();
    expect(await hooks.resolveId.call(context(), VIRTUAL)).toBe(`\0${VIRTUAL}`);
    expect(await hooks.resolveId.call(context('client'), VIRTUAL)).toBe(`\0${VIRTUAL}`);
    expect(await hooks.resolveId.call(context(), 'virtual:marmeon/pages')).toBeUndefined();
  });

  describe('Vitest', () => {
    for (const [version, refused] of [['5.0.5', true], ['5.1.0', true], [null, true], ['5.1.1-beta.1', true], ['5.1.1-0', true], ['unknown', true], ['5.1.1', false], ['5.2.0', false], ['6.0.0', false]] as const) {
      it(`${version ?? 'a missing version'} ${refused ? 'is refused with the install command' : 'passes'}`, () => {
        const { hooks, context } = plugin(version);
        const load = () => hooks.load.call(context(), `\0${VIRTUAL}`);
        if (refused) expect(load).toThrow('pnpm add -D vitest@^5.1.1');
        else expect(load()).toContain('globalThis[');
      });
    }
  });

  it('refuses resolve.preserveSymlinks', () => {
    const { hooks, context } = plugin();
    expect(() => hooks.load.call(context('server', null, true), `\0${VIRTUAL}`)).toThrow('preserveSymlinks');
  });
});

describe('the file an importer asks for', () => {
  /** A real file in a temp directory, and the id to ask for it. */
  function file(name: string) {
    const dir = tempDir('marmeon-test-packages-');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, 'export {};\n');
    return { dir, path, id: `${PREFIX}${encode(pathToFileURL(path).href)}` };
  }
  const real = (path: string) => realOf(path);

  for (const name of ['a%23b.ts', 'with space.ts', 'ünï.ts']) {
    it(`loads ${name}`, async () => {
      const { hooks, context } = plugin();
      const target = file(name);
      const resolved = await real(target.path);
      expect(await hooks.resolveId.call(context('server', { id: resolved, external: false }), target.id)).toBe(resolved);
    });
  }

  it('is resolved with this plugin skipped', async () => {
    const { hooks, context } = plugin();
    const target = file('a.ts');
    const ctx = context('server', { id: await real(target.path), external: false });
    await hooks.resolveId.call(ctx, target.id);
    expect(ctx.resolve).toHaveBeenCalledWith(target.path, undefined, { skipSelf: true });
  });

  it('refuses a "#" in the name: Vite would cut it down to the sibling', async () => {
    const { hooks, context } = plugin();
    const target = file('x#y.ts');
    writeFileSync(join(target.dir, 'x.ts'), 'throw new Error("the sibling ran");\n');
    const sibling = await real(join(target.dir, 'x.ts'));
    await expect(hooks.resolveId.call(context('server', { id: sibling, external: false }), target.id)).rejects.toThrow(`Vite resolved ${target.path} to ${sibling}, which is another file (an alias or a link?). The checked file would not be the one that runs.`);
    await expect(hooks.resolveId.call(context('server', { id: `${sibling}#y.ts`, external: false }), target.id)).rejects.toThrow(/"\?" or "#"/);
  });

  it('refuses a "?" in the id', async () => {
    const { hooks, context } = plugin();
    const target = file('a.ts');
    await expect(hooks.resolveId.call(context('server', { id: `${await real(target.path)}?raw`, external: false }), target.id)).rejects.toThrow(/"\?" or "#"/);
  });

  it('refuses an alias to a sibling: another file than the checked one, which never runs', async () => {
    const { hooks, context } = plugin();
    const target = file('a.ts');
    writeFileSync(join(target.dir, 'sibling.ts'), 'throw new Error("the sibling ran");\n');
    const sibling = await real(join(target.dir, 'sibling.ts'));
    let returned: unknown;
    const failure = await hooks.resolveId.call(context('server', { id: sibling, external: false }), target.id).then((id) => ((returned = id), undefined), (error: Error) => error);
    expect(returned).toBeUndefined();
    expect(failure?.message).toBe(`Vite resolved ${target.path} to ${sibling}, which is another file (an alias or a link?). The checked file would not be the one that runs.`);
  });

  it('refuses an external result', async () => {
    const { hooks, context } = plugin();
    const target = file('a.ts');
    await expect(hooks.resolveId.call(context('server', { id: await real(target.path), external: true }), target.id)).rejects.toThrow(/external/);
  });

  it('refuses what Vite cannot resolve, and what is no file URL, without falling back', async () => {
    const { hooks, context } = plugin();
    const target = file('a.ts');
    await expect(hooks.resolveId.call(context('server', null), target.id)).rejects.toThrow(/could not resolve/);
    await expect(hooks.resolveId.call(context('server', null), `${PREFIX}${encode('node:path')}`)).rejects.toThrow(/no file URL/);
    await expect(hooks.resolveId.call(context('server', null), `${PREFIX}${encode('https://example.com/a.ts')}`)).rejects.toThrow(/no file URL/);
  });
});
