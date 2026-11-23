import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { environment } from '../environment.ts';
import { importModule, importPackage } from './import-package.ts';

const IMPORTER = Symbol.for('marmeon.test.import');
const registered = globalThis as Record<symbol, unknown>;
const ROUTED = { routed: true };
const PLAIN = { by: 'load' };

/** A module file below `dir` (made on the way); its URL. */
function moduleAt(dir: string, ...path: string[]): string {
  const file = join(dir, ...path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'export const by = "node";\n');
  return pathToFileURL(file).href;
}

/** What `importPackage` made of `url`: `routed` when the registered importer answered, `load` when the caller's own import did. */
async function loaded(url: string, load: (url: string) => Promise<Record<string, unknown>> = vi.fn(async () => PLAIN)): Promise<string> {
  const module = await importPackage(url, load);
  return module === ROUTED ? 'routed' : 'load';
}

afterEach(() => {
  delete registered[IMPORTER];
  vi.unstubAllEnvs();
});

describe('the importer a test registers is never called', () => {
  const cases: [string, string | undefined][] = [
    ['production', 'production'],
    ['unset', undefined],
    ['empty', ''],
    ['unknown', 'staging'],
    ['a capitalised test', 'Test'],
  ];
  for (const [name, value] of cases) {
    it(`when NODE_ENV is ${name}`, async () => {
      const importer = vi.fn(async () => ROUTED);
      registered[IMPORTER] = importer;
      vi.stubEnv('NODE_ENV', value);
      const url = moduleAt(tempDir('marmeon-import-package-'), 'index.mjs');
      expect(await loaded(url)).toBe('load');
      expect(importer).not.toHaveBeenCalled();
      expect(importModule(url).routed).toBe(false);
    });
  }

  it('when something other than a function is registered', async () => {
    const url = moduleAt(tempDir('marmeon-import-package-'), 'index.mjs');
    for (const value of ['import', {}, 42, null, Promise.resolve(ROUTED)]) {
      registered[IMPORTER] = value;
      expect(await loaded(url)).toBe('load');
      expect(importModule(url).routed).toBe(false);
    }
  });

  it('for a file below a node_modules directory', async () => {
    const importer = vi.fn(async () => ROUTED);
    registered[IMPORTER] = importer;
    const url = moduleAt(tempDir('marmeon-import-package-'), 'node_modules', '@acme', 'thing', 'index.mjs');
    expect(await loaded(url)).toBe('load');
    expect(importModule(url).routed).toBe(false);
    expect(importer).not.toHaveBeenCalled();
  });

  it('for a file below a directory named Node_Modules', async () => {
    const importer = vi.fn(async () => ROUTED);
    registered[IMPORTER] = importer;
    const url = moduleAt(tempDir('marmeon-import-package-'), 'Node_Modules', 'thing', 'index.mjs');
    expect(await loaded(url)).toBe('load');
    expect(importModule(url).routed).toBe(false);
    expect(importer).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('for a file whose real path is below a node_modules directory, reached through a link', async () => {
    const importer = vi.fn(async () => ROUTED);
    registered[IMPORTER] = importer;
    const dir = tempDir('marmeon-import-package-');
    moduleAt(dir, 'store', 'node_modules', 'thing', 'index.mjs');
    symlinkSync(join(dir, 'store', 'node_modules', 'thing'), join(dir, 'linked'), 'dir');
    expect(await loaded(pathToFileURL(join(dir, 'linked', 'index.mjs')).href)).toBe('load');
    expect(importer).not.toHaveBeenCalled();
  });

  it('for a file that cannot be read', async () => {
    const importer = vi.fn(async () => ROUTED);
    registered[IMPORTER] = importer;
    const url = pathToFileURL(join(tempDir('marmeon-import-package-'), 'missing.mjs')).href;
    expect(await loaded(url)).toBe('load');
    expect(importer).not.toHaveBeenCalled();
  });

  it('for a URL that is no file', async () => {
    const importer = vi.fn(async () => ROUTED);
    registered[IMPORTER] = importer;
    expect(await loaded('node:path')).toBe('load');
    expect(importer).not.toHaveBeenCalled();
  });
});

describe('where no importer is registered', () => {
  it('the environment is not asked', () => {
    const asked = vi.spyOn(environment, 'isProtected');
    try {
      expect(importModule(pathToFileURL(join(tempDir('marmeon-import-package-'), 'index.mjs')).href).routed).toBe(false);
      expect(asked).not.toHaveBeenCalled();
    } finally {
      asked.mockRestore();
    }
  });
});

describe('the importer a test registers', () => {
  it('is called with the URL on every call, never cached, and `load` is never called', async () => {
    const importer = vi.fn(async () => ROUTED);
    registered[IMPORTER] = importer;
    const load = vi.fn(async () => PLAIN);
    const url = moduleAt(tempDir('marmeon-import-package-'), 'index.mjs');
    expect(await loaded(url, load)).toBe('routed');
    expect(await loaded(url, load)).toBe('routed');
    expect(importer.mock.calls).toEqual([[url], [url]]);
    expect(load).not.toHaveBeenCalled();
  });

  it('is asked again after the environment changed', async () => {
    const importer = vi.fn(async () => ROUTED);
    registered[IMPORTER] = importer;
    const url = moduleAt(tempDir('marmeon-import-package-'), 'index.mjs');
    vi.stubEnv('NODE_ENV', 'development');
    expect(await loaded(url)).toBe('routed');
    vi.stubEnv('NODE_ENV', 'production');
    expect(await loaded(url)).toBe('load');
    vi.stubEnv('NODE_ENV', 'test');
    expect(await loaded(url)).toBe('routed');
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('takes a directory named like node_modules without being one', async () => {
    const importer = vi.fn(async () => ROUTED);
    registered[IMPORTER] = importer;
    const dir = tempDir('marmeon-import-package-');
    expect(await loaded(moduleAt(dir, 'my_node_modules', 'index.mjs'))).toBe('routed');
    expect(await loaded(moduleAt(dir, 'node_modules_old', 'index.mjs'))).toBe('routed');
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('passes a rejection on, does not cache it, and never calls `load` for it', async () => {
    const failure = new Error('the test runner refused');
    const importer = vi.fn<(url: string) => Promise<unknown>>().mockRejectedValueOnce(failure).mockResolvedValue(ROUTED);
    registered[IMPORTER] = importer;
    const load = vi.fn(async () => PLAIN);
    const url = moduleAt(tempDir('marmeon-import-package-'), 'index.mjs');
    await expect(importPackage(url, load)).rejects.toBe(failure);
    expect(await loaded(url, load)).toBe('routed');
    expect(importer).toHaveBeenCalledTimes(2);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('importModule with an importer', () => {
  it('asks it on every call, never keeps its module, and never falls back to Node when it rejects', async () => {
    const failure = new Error('the test runner refused');
    const importer = vi.fn<(url: string) => Promise<unknown>>().mockResolvedValueOnce(ROUTED).mockRejectedValueOnce(failure).mockResolvedValue(ROUTED);
    registered[IMPORTER] = importer;
    const url = moduleAt(tempDir('marmeon-import-package-'), 'index.mjs');
    const first = importModule(url);
    expect(first.routed).toBe(true);
    expect(await first.module).toBe(ROUTED);
    const second = importModule(url);
    expect(second.module).not.toBe(first.module);
    await expect(second.module).rejects.toBe(failure);
    // the file is a good module: Node's import would have answered, and did not
    expect((await importModule(url).module).by).toBeUndefined();
    expect(importer).toHaveBeenCalledTimes(3);
  });
});

describe('importPackage without an importer', () => {
  it('calls `load` with the same URL on every call and returns what it gives, unchanged', async () => {
    const url = moduleAt(tempDir('marmeon-import-package-'), 'index.mjs');
    const answers = [{ n: 1 }, { n: 2 }];
    const load = vi.fn(async (_url: string) => answers.shift()!);
    expect(await importPackage(url, load)).toEqual({ n: 1 });
    expect(await importPackage(url, load)).toEqual({ n: 2 });
    expect(load.mock.calls).toEqual([[url], [url]]);
  });

  it('passes the failure of `load` on, and calls it again next time', async () => {
    const url = moduleAt(tempDir('marmeon-import-package-'), 'index.mjs');
    const load = vi.fn<(url: string) => Promise<Record<string, unknown>>>().mockRejectedValueOnce(new Error('gone')).mockResolvedValue(PLAIN);
    await expect(importPackage(url, load)).rejects.toThrow('gone');
    expect(await importPackage(url, load)).toBe(PLAIN);
  });
});

describe('importModule without an importer', () => {
  it('imports once and keeps the module by its URL', async () => {
    const url = moduleAt(tempDir('marmeon-import-package-'), 'index.mjs');
    const first = importModule(url);
    expect(first.routed).toBe(false);
    expect(importModule(url).module).toBe(first.module);
    expect((await first.module).by).toBe('node');
  });

  it('forgets a failed import, so a package installed meanwhile is found', async () => {
    const dir = tempDir('marmeon-import-package-');
    const url = pathToFileURL(join(dir, 'later.mjs')).href;
    await expect(importModule(url).module).rejects.toThrow();
    writeFileSync(join(dir, 'later.mjs'), 'export const by = "node";\n');
    expect((await importModule(url).module).by).toBe('node');
  });
});
