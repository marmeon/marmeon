import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isNamespace, packageTexts, type PackageSurface } from '@marmeon/core/internal';
import { normalizePath, type Plugin } from 'vite';
import { codeString } from './package-pages.ts';

const LANG_PREFIX = 'virtual:marmeon/lang/';

/**
 * Merges the app's file over the package's, key by key — what `mergeTexts` of `@marmeon/i18n` does on the server (a test holds the two
 * to the same texts). It sits in the generated module because the module cannot count on resolving `@marmeon/i18n` from the app's root.
 */
const COMPOSE = `const tree = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const merge = (base, overrides) => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key];
    merged[key] = tree(current) && tree(value) ? merge(current, value) : value;
  }
  return merged;
};
const compose = (namespace, own, overrides) => {
  const locales = new Map();
  for (const [locale, load] of Object.entries(own)) locales.set(locale, { own: load });
  for (const [path, load] of Object.entries(overrides)) {
    const locale = /\\/([^/]+)\\.[jt]s$/.exec(path)?.[1];
    if (locale !== undefined) locales.set(locale, { ...locales.get(locale), override: load });
  }
  const files = {};
  for (const [locale, { own, override }] of locales) {
    files['modules/' + namespace + '/lang/' + locale + '.ts'] = own && override ? () => Promise.all([own(), override()]).then(([base, over]) => ({ default: merge(base.default, over.default) })) : own ?? override;
  }
  return files;
};
`;

/** The package texts under the client's conditions: only `lang` is read here, so a missing target of another part of the package is no concern of this module. */
function textsOf(root: string, conditions: readonly string[]): ReturnType<typeof packageTexts> {
  // An app without a readable package.json has no packages; the check that names that file's problem runs elsewhere.
  try {
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  return packageTexts({ root, conditions });
}

/** `compose(...)` for one package: its files by locale, and the app's `lang/<namespace>/` laid over them. */
function composed(namespace: string, lang: Readonly<Record<string, string>>): string {
  const own = Object.entries(lang).map(([locale, file]) => `${codeString(locale)}: () => import(${codeString(normalizePath(realpathSync.native(file)))})`);
  const overrides = [`/lang/${namespace}/*.{js,ts}`, `!/lang/${namespace}/*.test.ts`, `!/lang/${namespace}/*.type-test.ts`, `!/lang/${namespace}/*.d.ts`];
  return `compose(${codeString(namespace)}, { ${own.join(', ')} }, import.meta.glob(${JSON.stringify(overrides)}))`;
}

export interface PackageLangOptions {
  readonly root: () => string;
  /** The client's conditions, as discovery matches them. */
  readonly conditions: () => readonly string[];
  readonly packages: () => readonly PackageSurface[];
}

/**
 * What `virtual:marmeon/lang` adds to the app's own language files: the texts of every package that has no entry, as
 * `modules/<namespace>/lang/<locale>.ts` entries next to the app's. A package with an entry is not in it — its texts go to
 * `virtual:marmeon/lang/<namespace>`, so a page of the app never loads them. Empty (the module stays as it was) without such a package.
 */
export function packageLangExtension(options: PackageLangOptions): { imports: string; entries: string } | undefined {
  const withEntry = new Set(options.packages().flatMap((surface) => (surface.entry === undefined ? [] : [surface.namespace])));
  const shared = textsOf(options.root(), options.conditions()).filter((texts) => !withEntry.has(texts.namespace));
  if (shared.length === 0) return undefined;
  return { imports: COMPOSE, entries: shared.map((texts) => `...${composed(texts.namespace, texts.lang)}`).join(', ') };
}

/**
 * `virtual:marmeon/lang/<namespace>` — the language files of a package with an entry, for `createMessageLoader` (keys as in
 * `virtual:marmeon/lang`), with the app's `lang/<namespace>/<locale>.ts` laid over them key by key. The package's entry imports it. A
 * namespace no installed package declares together with an entry is an error: an empty module would hide a typo.
 */
export function packageLang(options: PackageLangOptions): Plugin {
  // With an entry and texts: the server ignores `lang/<namespace>/` of a package that ships none, so the browser must not serve it either.
  const known = (namespace: string): boolean =>
    isNamespace(namespace) &&
    options.packages().some((surface) => surface.namespace === namespace && surface.entry !== undefined) &&
    textsOf(options.root(), options.conditions()).some((texts) => texts.namespace === namespace);
  return {
    name: 'marmeon:package-lang',
    resolveId(source) {
      if (!source.startsWith(LANG_PREFIX)) return undefined;
      if (!known(source.slice(LANG_PREFIX.length))) {
        this.error(`${JSON.stringify(source)}: no installed package declares that namespace together with an entry and texts in its "marmeon" field.`);
      }
      return `\0${source}`;
    },
    load(id) {
      if (!id.startsWith(`\0${LANG_PREFIX}`)) return undefined;
      const namespace = id.slice(LANG_PREFIX.length + 1);
      if (!known(namespace)) this.error(`${JSON.stringify(id.slice(1))}: no installed package declares that namespace together with an entry and texts in its "marmeon" field.`);
      const lang = textsOf(options.root(), options.conditions()).find((texts) => texts.namespace === namespace)?.lang ?? {};
      return `${COMPOSE}export default ${composed(namespace, lang)};\n`;
    },
  };
}
