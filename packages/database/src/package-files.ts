import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result, type ServiceProviderClass } from '@marmeon/core';
import { belongsTo, withCode } from '@marmeon/core/internal';
import { discoverable, exportedClasses, MAX_BYTES, MAX_FILES, readRegularFile, show, shown, type ProviderPackage } from './package-migrations.ts';

/** What a service provider declares in `static publishes`: the directories of files its package lets an app copy in. */
export interface ProviderPublishes {
  /**
   * The language files of the framework's texts, as a `file:` URL: `new URL('../stubs/lang', import.meta.url)`. Only
   * `@marmeon/i18n` can declare it in this version; `marmeon publish @marmeon/i18n --only=lang` copies them into `lang/marmeon/`.
   * See `docs/package-development.md#declaring-the-files-a-package-publishes`.
   */
  readonly lang?: URL;
}

/** One language file a package ships: `name` is the file name (`en.ts`), `file` its POSIX path in the package. */
export interface PackageLangFile {
  readonly name: string;
  readonly file: string;
  readonly contents: string;
}

/** The language files a package declares, read and checked; `files` are sorted by name. */
export interface PackageLang {
  /** The directory of the package that holds the files. */
  readonly from: string;
  readonly files: readonly PackageLangFile[];
}

/** A package's declaration of files that cannot be used; `message` starts with the code D25. */
export interface PackageFilesError {
  readonly kind: 'invalid-package-files';
  readonly message: string;
}

/** The only package that can publish language files: they land in `lang/marmeon/`, which belongs to its texts. */
export const LANG_PACKAGE = '@marmeon/i18n';

const LANG_FILE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*\.ts$/;

function invalid(pkg: { name: string }, why: string): Result<never, PackageFilesError> {
  return err({ kind: 'invalid-package-files', message: withCode('D25', `${show(pkg.name)} declares the files it publishes wrongly: ${why}`) });
}

/**
 * One `static publishes` as read from a provider: parsed once, or why it cannot be. `value` only stands for the identity of the
 * object; `classes` are the provider classes that carry it.
 * @internal
 */
export type PublishDeclaration =
  | { readonly provider: string; readonly ok: true; readonly value: object; readonly path: string; readonly keys: readonly string[]; readonly classes: ServiceProviderClass[] }
  | { readonly provider: string; readonly ok: false; readonly message: string; readonly classes: ServiceProviderClass[] };

type Parsed = Extract<PublishDeclaration, { ok: true }>;

function wrongly(Provider: ServiceProviderClass, provider: string, why: string): PublishDeclaration {
  return { provider, ok: false, message: withCode('D25', `${provider} declares the files it publishes wrongly: ${why}`), classes: [Provider] };
}

/**
 * The `static publishes` of `providers`, each read once; the same object twice (a subclass inherits it), or the same directory
 * twice, counts once. The static comes from code the app did not write: every property is read a single time and the URL is
 * copied, so a getter or a proxy cannot show another value after the check.
 * @internal
 */
export function publishDeclarations(providers: readonly ServiceProviderClass[]): PublishDeclaration[] {
  const byValue = new Map<object, Parsed>();
  const byPath = new Map<string, Parsed>();
  const declarations: PublishDeclaration[] = [];
  for (const Provider of providers) {
    let provider: string;
    try {
      provider = show(String(Provider.name));
    } catch {
      provider = '"(unnamed provider)"';
    }
    try {
      const value: unknown = (Provider as { publishes?: unknown }).publishes;
      if (value === undefined) continue;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        declarations.push(wrongly(Provider, provider, 'static publishes must be an object: { lang: new URL(…) }.'));
        continue;
      }
      const same = byValue.get(value);
      if (same) {
        same.classes.push(Provider);
        continue;
      }
      const keys = Object.keys(value);
      const { lang } = value as { lang?: unknown };
      if (!(lang instanceof URL)) {
        declarations.push(wrongly(Provider, provider, "lang must be a file: URL, such as new URL('../stubs/lang', import.meta.url)."));
        continue;
      }
      const url = new URL(String(lang.href));
      if (url.protocol !== 'file:' || url.host !== '' || url.search !== '' || url.hash !== '') {
        declarations.push(wrongly(Provider, provider, 'lang must be a file: URL without a host, a query or a fragment.'));
        continue;
      }
      const path = resolve(fileURLToPath(url));
      const key = JSON.stringify([[...keys].sort(), path]);
      const twin = byPath.get(key);
      if (twin) {
        twin.classes.push(Provider);
        byValue.set(value, twin);
        continue;
      }
      const declaration: Parsed = { provider, ok: true, value, path, keys, classes: [Provider] };
      byValue.set(value, declaration);
      byPath.set(key, declaration);
      declarations.push(declaration);
    } catch {
      declarations.push(wrongly(Provider, provider, 'static publishes cannot be read.'));
    }
  }
  return declarations;
}

/** The language files in `directory`, the real path of a directory inside the package; `from` is its POSIX path, for messages. */
function readLangDirectory(pkg: { name: string; dir: string }, directory: string, from: string): Result<readonly PackageLangFile[], PackageFilesError> {
  const fail = (why: string) => invalid(pkg, why);
  let root: string;
  try {
    root = realpathSync(pkg.dir);
  } catch {
    return fail('the package directory cannot be read.');
  }
  let entries: string[];
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return fail(`${show(from)} cannot be read.`);
  }
  if (entries.length > MAX_FILES) return fail(`${show(from)} holds more than ${MAX_FILES} files.`);

  const files: PackageLangFile[] = [];
  for (const entry of entries) {
    if (!LANG_FILE.test(entry)) return fail(`${show(entry)} must be named after a language: <tag>.ts, such as en.ts or pt-BR.ts.`);
    const path = `${from}/${entry}`;
    let real: string;
    try {
      real = realpathSync(join(directory, entry));
    } catch {
      return fail(`${show(path)} cannot be read.`);
    }
    if (!belongsTo(root, real)) return fail(`${show(path)} leads out of the package.`);
    const read = readRegularFile(real, root);
    if (!read.ok) {
      if (read.why === 'not-a-file') return fail(`${show(path)} is no file.`);
      if (read.why === 'too-large') return fail(`${show(path)} is larger than ${MAX_BYTES} bytes.`);
      if (read.why === 'not-utf8') return fail(`${show(path)} is not valid UTF-8.`);
      if (read.why === 'no-migration') return fail(`${show(path)} has no default export.`);
      return fail(`${show(path)} cannot be read.`);
    }
    files.push({ name: entry, file: path, contents: read.contents });
  }
  if (files.length === 0) return fail(`${show(from)} holds no language file.`);
  return ok(files);
}

function readDeclaration(pkg: ProviderPackage, root: string, mine: readonly Parsed[]): Result<PackageLang | undefined, PackageFilesError> {
  const fail = (why: string) => invalid(pkg, why);
  if (mine.length === 0) return ok(undefined);
  if (mine.length > 1) return fail(`declared by two service providers: ${mine.map((declaration) => declaration.provider).join(' and ')} — a package declares one directory.`);
  const declaration = mine[0]!;
  const where = shown(pkg, root, declaration.path);
  for (const key of declaration.keys) if (key !== 'lang') return fail(`unknown key ${show(key)} (known: lang).`);

  let real: string;
  try {
    real = realpathSync(declaration.path);
  } catch {
    return fail(`${where} does not exist in the package.`);
  }
  if (real === root) return fail(`${where} leads out of the package: it is the package itself.`);
  if (!belongsTo(root, real)) return fail(`${where} leads out of the package.`);
  try {
    if (!statSync(real).isDirectory()) return fail(`${where} is no directory.`);
  } catch {
    return fail(`${where} cannot be read.`);
  }
  const from = relative(root, real).split(sep).join('/');
  const files = readLangDirectory(pkg, real, from);
  if (!files.ok) return files;
  return ok({ from, files: files.value });
}

/** A package as {@link assignPublishes} needs it: with the name its own `package.json` gives. */
export type PublishingPackage = ProviderPackage & { readonly json: { readonly name?: unknown } };

/**
 * Gives each valid `static publishes` to one package, the way `assignMigrations` gives migrations: the package with the longest
 * real directory that holds the declared directory, and only when one of the classes carrying it is exported by that package's
 * main entry. A package that is not {@link LANG_PACKAGE} (by its own `package.json`) gets a warning and publishes nothing.
 * `warnings` never change a result: declarations a package does not claim, and unreadable ones no package exports.
 * @internal
 */
export async function assignPublishes(
  packages: readonly PublishingPackage[],
  declarations: readonly PublishDeclaration[],
): Promise<{ results: Map<ProviderPackage, Result<PackageLang | undefined, PackageFilesError>>; warnings: string[] }> {
  const results = new Map<ProviderPackage, Result<PackageLang | undefined, PackageFilesError>>();
  const warnings: string[] = [];
  const roots = new Map<ProviderPackage, string>();
  for (const pkg of packages) {
    try {
      roots.set(pkg, realpathSync(pkg.dir));
    } catch {
      results.set(pkg, invalid(pkg, 'the package directory cannot be read.'));
    }
  }

  const located = new Map<ProviderPackage, Parsed[]>();
  for (const declaration of declarations) {
    if (!declaration.ok) continue;
    let real: string | undefined;
    try {
      real = realpathSync(declaration.path);
    } catch {
      // checked below, for the package whose path it is
    }
    let best: ProviderPackage | undefined;
    for (const [pkg, root] of roots) {
      const here = belongsTo(root, declaration.path) || belongsTo(resolve(pkg.dir), declaration.path) || (real !== undefined && belongsTo(root, real));
      if (here && (best === undefined || root.length > roots.get(best)!.length)) best = pkg;
    }
    if (best !== undefined) located.set(best, [...(located.get(best) ?? []), declaration]);
  }

  const unreadable = declarations.filter((declaration) => !declaration.ok);
  const placed = new Set<PublishDeclaration>();
  for (const pkg of packages) {
    const root = roots.get(pkg);
    if (root === undefined) continue;
    try {
      const here = located.get(pkg) ?? [];
      const exported = here.length > 0 || (unreadable.length > 0 && discoverable(pkg)) ? await exportedClasses(pkg, root) : undefined;
      const exports = (declaration: PublishDeclaration) => exported !== undefined && 'classes' in exported && declaration.classes.some((Provider) => exported.classes.has(Provider));
      const mine = here.filter((declaration) => {
        if (exports(declaration)) return true;
        const reason = exported && 'reason' in exported ? exported.reason : 'the package does not export that provider at its main entry';
        warnings.push(`${declaration.provider} declares files in ${shown(pkg, root, declaration.path)} of ${show(pkg.name)}, which does not claim them: ${reason}.`);
        return false;
      });
      const broken = unreadable.filter((declaration) => exports(declaration));
      for (const declaration of broken) placed.add(declaration);
      // The name the package.json gives itself, not the name the app lists it under: an alias must not pass for the framework's package.
      if ((mine.length > 0 || broken.length > 0) && pkg.json.name !== LANG_PACKAGE) {
        warnings.push(`${show(pkg.name)} declares language files, but only the framework's texts (${LANG_PACKAGE}) can be published — ignored.`);
        results.set(pkg, ok(undefined));
      } else if (broken.length > 0) results.set(pkg, err({ kind: 'invalid-package-files', message: (broken[0] as { message: string }).message }));
      else results.set(pkg, readDeclaration(pkg, root, mine));
    } catch {
      results.set(pkg, invalid(pkg, 'the package cannot be read.'));
    }
  }
  for (const declaration of unreadable) {
    if (!placed.has(declaration)) warnings.push((declaration as { message: string }).message);
  }
  return { results, warnings };
}
