import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServiceProviderClass } from '@marmeon/core';

const registry = ((globalThis as { __langProvidersOfTest?: Map<string, unknown> }).__langProvidersOfTest ??= new Map<string, unknown>());

export const EN = "export default { status: { '404': 'Not Found' } };\n";
export const DE = "export default { status: { '404': 'Nicht gefunden' } };\n";

export interface InstalledLang {
  readonly dir: string;
  readonly Provider: ServiceProviderClass;
}

/**
 * Writes a package into `<root>/node_modules` whose entry exports a service provider that declares `static publishes`.
 * `files` are the files of the package by path; `publishes` is the declaration (by default `{ lang: <package>/stubs/lang }`);
 * `json` is merged over the package.json, `dependency: false` leaves the package out of the app's dependencies.
 */
export function installLangPackage(
  root: string,
  name: string,
  files: Record<string, string>,
  extra: { publishes?: (dir: string) => unknown; json?: Record<string, unknown>; dependency?: boolean } = {},
): InstalledLang {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', exports: './index.js', ...extra.json }));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  // The real path, as `import.meta.url` is.
  const real = realpathSync(dir);
  const publishes = extra.publishes ? extra.publishes(real) : { lang: pathToFileURL(join(real, 'stubs/lang')) };
  const Provider = class {
    static publishes = publishes;
  };
  Object.defineProperty(Provider, 'name', { value: `${name.replace(/\W+/g, '_')}ServiceProvider` });
  registry.set(dir, Provider);
  writeFileSync(join(dir, 'index.js'), `export const provider = globalThis.__langProvidersOfTest.get(${JSON.stringify(dir)});\n`);
  if (extra.dependency !== false) {
    const file = join(root, 'package.json');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    json.dependencies[name] = '1.2.3';
    writeFileSync(file, JSON.stringify(json));
  }
  return { dir, Provider: Provider as unknown as ServiceProviderClass };
}
