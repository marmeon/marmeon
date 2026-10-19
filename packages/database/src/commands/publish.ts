import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { findPackage, printable } from '@marmeon/core/internal';
import type { CommandInput } from 'marmeon';
import { type PackageMigrationFile, type PackageMigrations, readPackageMigrations } from '../package-migrations.ts';
import { appMigrations, findMigration, publishMigration, SYSTEM_MODULE, timestamp } from './publish-migration.ts';

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock'];

type Package = NonNullable<ReturnType<typeof findPackage>>;

/**
 * The installed package `name` of the app: in `node_modules` of the app, or of a directory above it up to the first one with a
 * lockfile (a workspace root, where the package manager hoists). Never further — a `node_modules` next to the home directory is
 * not the app's.
 */
function locate(name: string, root: string): Package | undefined {
  const hasLockfile = (dir: string) => LOCKFILES.some((lockfile) => existsSync(join(dir, lockfile)));
  const directories: string[] = [];
  for (let dir = root; ; dir = dirname(dir)) {
    directories.push(dir);
    if (hasLockfile(dir)) break;
    if (dirname(dir) === dir) {
      // no lockfile anywhere above: the app stands alone
      directories.length = 1;
      break;
    }
  }
  for (const dir of directories) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return findPackage(name, dir);
  }
  return undefined;
}

/** The module whose `index.ts` carries the line `publish` writes when it creates a module for `name`. */
function ownedModule(modules: string, name: string): string | undefined {
  if (!existsSync(modules)) return undefined;
  const line = `// The tables of ${name}: \`marmeon publish ${name}\` writes their migrations here.`;
  for (const module of readdirSync(modules)) {
    if (!KEBAB.test(module)) continue;
    try {
      if (readFileSync(join(modules, module, 'index.ts'), 'utf8').split(/\r?\n/).includes(line)) return module;
    } catch {
      // no index.ts: not a module `publish` made
    }
  }
  return undefined;
}

/**
 * Whether the app's specification of a dependency installs it from the registry: a semver range, a dist-tag or `catalog:`.
 * Anything with a `/` or another `:` is an alias, a path, a repository or a tarball; `.tgz` ends a tarball name.
 */
function fromRegistry(spec: unknown): boolean {
  if (typeof spec !== 'string') return false;
  const text = spec.trim();
  if (text.startsWith('catalog:')) return !text.includes('/');
  return !text.includes('/') && !text.includes(':') && !text.endsWith('.tgz');
}

/**
 * Whether the existing module `module` may be opened for `name` without `--module`: `system` for a package of the framework
 * itself — named `@marmeon/…` by its own `package.json` and listed by the app with a registry specification.
 */
function opensSystem(module: string, name: string, pkg: Package, dependencies: Record<string, unknown>): boolean {
  if (module !== SYSTEM_MODULE || !name.startsWith('@marmeon/') || pkg.json.name !== name) return false;
  const spec = dependencies[name];
  return fromRegistry(spec);
}

/** What `publish` would do for one package: the files the app lacks, and the ones it has. */
export interface Plan {
  readonly package: string;
  /** Where the missing files go; undefined when nothing is missing. */
  readonly module?: string;
  /** The package named in the comment of a module that is created; none for `system`. */
  readonly owner?: string;
  readonly missing: readonly PackageMigrationFile[];
  readonly present: readonly { readonly name: string; readonly path: string }[];
}

/**
 * Where an installed direct dependency that lists migrations stands in the app. `used` is whether the app has at least one of
 * its migrations — `publish --check` and the check `package-migrations` look only at those.
 */
export type Status = { readonly package: string; readonly used: boolean } & (
  | { readonly state: 'complete' }
  | { readonly state: 'lacks'; readonly missing: readonly string[] }
  | { readonly state: 'unpublished'; readonly missing: readonly string[] }
  | { readonly state: 'refused'; readonly reason: string }
);

type Entry =
  | { readonly kind: 'ok'; readonly pkg: Package; readonly manifest: PackageMigrations }
  | { readonly kind: 'none' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly message: string; readonly pkg?: Package };

interface Context {
  readonly root: string;
  readonly modules: string;
  readonly dependencies: Record<string, unknown>;
  readonly entries: Map<string, Entry>;
  readonly app: ReturnType<typeof appMigrations>;
  /** The valid packages that ship a migration of that name. */
  readonly shippers: Map<string, string[]>;
}

/** Reads the direct dependencies of the app and the migrations each lists; undefined when the `package.json` cannot be read. */
function inspect(root: string): Context | undefined {
  let dependencies: Record<string, unknown> = Object.create(null);
  try {
    const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object };
    dependencies = Object.assign(Object.create(null), json.dependencies, json.devDependencies);
  } catch {
    return undefined;
  }
  const entries = new Map<string, Entry>();
  const shippers = new Map<string, string[]>();
  for (const name of Object.keys(dependencies).sort()) {
    try {
      const pkg = locate(name, root);
      if (!pkg) {
        entries.set(name, { kind: 'absent' });
        continue;
      }
      const read = readPackageMigrations(pkg);
      if (!read.ok) entries.set(name, { kind: 'error', message: read.error.message, pkg });
      else if (!read.value) entries.set(name, { kind: 'none' });
      else {
        entries.set(name, { kind: 'ok', pkg, manifest: read.value });
        for (const file of read.value.files) shippers.set(file.name, [...(shippers.get(file.name) ?? []), name]);
      }
    } catch (error) {
      entries.set(name, { kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
  const modules = join(root, 'modules');
  return { root, modules, dependencies, entries, app: appMigrations(modules), shippers };
}

const presentOf = (context: Context, manifest: PackageMigrations) =>
  manifest.files.flatMap((file) => {
    const found = context.app.byName.get(file.name);
    return found ? [{ name: file.name, path: relative(context.root, found.path) }] : [];
  });

/**
 * The plan for one package whose migrations are read, or why it is refused: a name another installed dependency ships too
 * (both are refused), a file missing before one the app has, or no module to put the files in.
 */
function planOne(context: Context, name: string, pkg: Package, manifest: PackageMigrations, explicit: string | undefined): { plan: Plan } | { refusal: string } {
  if (explicit !== undefined && !KEBAB.test(explicit)) return { refusal: 'Pass the module as a kebab-case name: --module=<name>.' };

  // A migration is named after its table: two packages that ship one name would create the table twice.
  for (const file of manifest.files) {
    const other = context.shippers.get(file.name)?.find((candidate) => candidate !== name);
    if (other !== undefined) return { refusal: `${name} and ${other} both ship ${file.name} — one name is one migration in an app, so they cannot both be published` };
  }

  const present = presentOf(context, manifest);
  const missing = manifest.files.filter((file) => !context.app.byName.has(file.name));

  // Migrations run in the order of their timestamps: a file that lands behind one the app has already run would never be in order.
  for (const [index, file] of manifest.files.entries()) {
    if (context.app.byName.has(file.name)) continue;
    const later = manifest.files.slice(index + 1).find((candidate) => context.app.byName.has(candidate.name));
    if (later) {
      const path = relative(context.root, context.app.byName.get(later.name)!.path);
      return {
        refusal: `${file.name} of ${name} is not in your app, but ${later.name}, which comes after it, is (${path}). Copy ${basename(file.file)} from node_modules/${name} into that module by hand, with a timestamp before ${later.name} — with an empty up() if your app does not want it.`,
      };
    }
  }

  const modules = context.modules;
  const { dependencies } = context;
  // The module: --module; else the one `publish` made for this package (its index.ts says so), in which every file of the package
  // that the app has must lie; else the proposal. A module of the app that exists is opened only by --module, by that line, or
  // — `system` — for a package of the framework itself: a package from outside must not put tables into a module of the app,
  // and a file of the package in some module is no reason to.
  const elsewhere = (file: string, where: string) =>
    `Your app already has a migration named ${file} in modules/${where}, and ${name} ships one by that name. If publish should put the files of ${name} there, pass --module=${where}; otherwise ${name} ships a name your app uses for something else.`;
  let module = explicit;
  if (module === undefined) {
    const owned = ownedModule(modules, name);
    if (owned !== undefined) {
      for (const file of manifest.files) {
        if (findMigration(modules, file.name, owned) !== undefined) continue;
        const found = findMigration(modules, file.name);
        if (found) return { refusal: elsewhere(file.name, basename(dirname(dirname(found)))) };
      }
      module = owned;
    } else if (missing.length > 0) {
      for (const file of manifest.files) {
        const found = findMigration(modules, file.name);
        const where = found && basename(dirname(dirname(found)));
        if (where !== undefined && !(where === manifest.module && opensSystem(manifest.module, name, pkg, dependencies))) {
          return { refusal: elsewhere(file.name, where) };
        }
      }
      module = manifest.module;
      if (existsSync(join(modules, module)) && !opensSystem(module, name, pkg, dependencies)) {
        return { refusal: `modules/${module} is your app's — pass --module=<name> to put the tables of ${name} there, or another name.` };
      }
    }
  }
  // `publishMigration` does not check a module it is given.
  if (module !== undefined && !KEBAB.test(module)) return { refusal: 'Pass the module as a kebab-case name: --module=<name>.' };

  return { plan: { package: name, module, owner: module === SYSTEM_MODULE ? undefined : name, missing, present } };
}

/**
 * Plans `publish` for `packages` without writing anything: a plan for each, and the reasons any was refused (when there is
 * one, nothing is to be written for any package). `module` is `--module`, for a single package.
 */
export function planPublish(root: string, packages: readonly string[], module?: string): { plans: Plan[]; refusals: string[] } {
  const plans: Plan[] = [];
  const refusals: string[] = [];
  const context = inspect(root);
  if (!context) return { plans, refusals: ['The package.json of your app cannot be read.'] };
  const chosen: { name: string; pkg: Package }[] = [];
  for (const name of new Set(packages)) {
    if (!(name in context.dependencies)) {
      refusals.push(`${name} is not a dependency of your app — add it first.`);
      continue;
    }
    const entry = context.entries.get(name)!;
    if (entry.kind === 'error') refusals.push(entry.message);
    else if (entry.kind === 'absent') refusals.push(`${name} is not installed in your app — install your dependencies first.`);
    else if (entry.kind === 'none') refusals.push(`${name} ships no migrations.`);
    else {
      const planned = planOne(context, name, entry.pkg, entry.manifest, module);
      if ('plan' in planned) {
        plans.push(planned.plan);
        chosen.push({ name, pkg: entry.pkg });
      } else refusals.push(planned.refusal);
    }
  }

  // Two packages of one run must not both create the same module, unless it is `system` and both are the framework's.
  const creating = new Map<string, string>();
  for (const plan of plans) {
    if (plan.missing.length === 0 || plan.module === undefined || existsSync(join(context.modules, plan.module))) continue;
    const first = creating.get(plan.module);
    if (first === undefined) {
      creating.set(plan.module, plan.package);
      continue;
    }
    const framework = (name: string) => {
      const pkg = chosen.find((entry) => entry.name === name)!.pkg;
      return opensSystem(SYSTEM_MODULE, name, pkg, context.dependencies);
    };
    if (plan.module === SYSTEM_MODULE && framework(first) && framework(plan.package)) continue;
    refusals.push(`${first} and ${plan.package} would both create modules/${plan.module} — publish them one at a time, or pass --module=<name> for each.`);
  }
  return { plans, refusals };
}

/**
 * Whether the app publishes from the package: `publish` made a module for it, or it is a package of the framework with a
 * migration in `system`. A migration of the app that happens to have a name of the package does not make it used.
 */
function used(context: Context, name: string, entry: Entry): boolean {
  if (ownedModule(context.modules, name) !== undefined) return true;
  // A package of the framework, by its own package.json: the allowlist of specifications is for opening `system`, not for checking it.
  if (entry.kind !== 'ok' || !name.startsWith('@marmeon/') || entry.pkg.json.name !== name) return false;
  return entry.manifest.files.some((file) => findMigration(context.modules, file.name, SYSTEM_MODULE) !== undefined);
}

/** Where every installed direct dependency that lists migrations stands in the app, by package name. */
export function packageStatus(root: string): Status[] {
  const context = inspect(root);
  if (!context) return [];
  const statuses: Status[] = [];
  for (const [name, entry] of context.entries) {
    if (entry.kind === 'error') {
      statuses.push({ package: name, used: used(context, name, entry), state: 'refused', reason: entry.message });
      continue;
    }
    if (entry.kind !== 'ok') continue;
    const isUsed = used(context, name, entry);
    const planned = planOne(context, name, entry.pkg, entry.manifest, undefined);
    if ('refusal' in planned) statuses.push({ package: name, used: isUsed, state: 'refused', reason: planned.refusal });
    else if (planned.plan.missing.length === 0) statuses.push({ package: name, used: isUsed, state: 'complete' });
    else statuses.push({ package: name, used: isUsed, state: isUsed ? 'lacks' : 'unpublished', missing: planned.plan.missing.map((file) => file.name) });
  }
  return statuses;
}

/** The lines the list shows for a package. A reason names the package itself, so it is not prefixed again. */
const describe = (status: Status): string[] => {
  switch (status.state) {
    case 'complete':
      return [`${status.package} — complete`];
    case 'lacks':
      return [`${status.package} — lacks ${status.missing.length}: ${status.missing.join(', ')}`];
    case 'unpublished':
      return [`${status.package} — not published (${status.missing.length})`];
    case 'refused':
      return [`${status.package} — refused`, `  ${status.reason}`];
  }
};


/** Everything `publish` prints passes `printable`: names and messages that come from a package or from file names are not trusted with a terminal. */
function safe(output: CommandInput['output']): CommandInput['output'] {
  return {
    line: (text = '') => output.line(printable(text)),
    info: (text: string) => output.info(printable(text)),
    success: (text: string) => output.success(printable(text)),
    warn: (text: string) => output.warn(printable(text)),
    error: (text: string) => output.error(printable(text)),
  } as unknown as CommandInput['output'];
}

/** The timestamps for `count` new files, a second apart and behind `newest`, or why that cannot be. */
function stamps(count: number, newest: string | undefined, newestPath: string | undefined, root: string): { stamps: Date[] } | { error: string } {
  const now = Math.floor(Date.now() / 1000) * 1000;
  let start = now;
  if (newest !== undefined && newest >= timestamp(new Date(now))) {
    const match = /^(\d{4})_(\d{2})_(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(newest);
    const [year, month, day, hour, minute, second] = (match?.slice(1) ?? []).map(Number) as number[];
    if (!match || month! < 1 || month! > 12 || day! < 1 || day! > 31 || hour! > 23 || minute! > 59 || second! > 59) {
      return { error: `${relative(root, newestPath!)} has a timestamp that is no date, so a copy cannot be put behind it — rename it with a valid one.` };
    }
    start = Date.UTC(year!, month! - 1, day!, hour, minute, second) + 1000;
  }
  const dates = Array.from({ length: count }, (_, index) => new Date(start + index * 1000));
  for (const date of dates) {
    const stamp = timestamp(date);
    if (!/^\d{4}_/.test(stamp) || (newest !== undefined && stamp <= newest)) {
      return { error: `${relative(root, newestPath!)} has a timestamp that leaves no room behind it — rename it with an earlier one.` };
    }
  }
  return { stamps: dates };
}

/**
 * `marmeon publish [<package>] [--module=<name>] [--check]` copies the migrations of a direct dependency of your app into a
 * module, or with `--check` says what is missing. Nothing is written unless every chosen package can be published; see
 * `docs/migrations.md#publishing-the-migrations-of-a-package`.
 */
export class PublishCommand {
  static command = 'publish';
  static description = 'Copy the migrations of your packages into your app, or check that they are there';
  static usage = '[<package>] [--module=<name>] [--check]';
  static options = { module: { type: 'string', short: 'm' }, check: { type: 'boolean' } } as const;

  async handle(raw: CommandInput): Promise<number> {
    const input: CommandInput = { ...raw, output: safe(raw.output) };
    const { output } = input;
    const name = input.args[0];
    const module = typeof input.options.module === 'string' ? input.options.module : undefined;
    if (input.args.length > 1) {
      output.error('Pass one package at most: marmeon publish [<package>] [--module=<name>] [--check]');
      return 1;
    }
    if (module !== undefined && name === undefined) {
      output.error('--module needs a package: marmeon publish <package> --module=<name>');
      return 1;
    }

    if (input.options.check === true) return name === undefined ? this.#checkUsed(input) : this.#check(input, name, module);
    if (name !== undefined) return this.#publish(input, [name], module);
    return this.#choose(input);
  }

  /** `--check <package>`: that package, used or not. */
  #check(input: CommandInput, name: string, module: string | undefined): number {
    const { plans, refusals } = planPublish(input.root, [name], module);
    for (const refusal of refusals) input.output.error(refusal);
    if (refusals.length > 0) return 1;
    const lacking = plans[0]!.missing;
    if (lacking.length > 0) {
      input.output.error(`${name} lacks ${lacking.length}: ${lacking.map((file) => file.name).join(', ')} — marmeon publish ${name} writes ${lacking.length === 1 ? 'it' : 'them'}`);
      return 1;
    }
    input.output.success(`Every migration of ${name} is in your app`);
    return 0;
  }

  /** `--check` alone: the packages the app publishes from. */
  #checkUsed(input: CommandInput): number {
    let failed = false;
    for (const status of packageStatus(input.root)) {
      if (!status.used || (status.state !== 'lacks' && status.state !== 'refused')) continue;
      failed = true;
      if (status.state === 'lacks') input.output.error(`${status.package} lacks ${status.missing.length}: ${status.missing.join(', ')} — marmeon publish ${status.package}`);
      else input.output.error(status.reason);
    }
    if (failed) return 1;
    input.output.success('Every package you publish from has its migrations in your app');
    return 0;
  }

  /** No package: list, and at a terminal let the person choose. */
  async #choose(input: CommandInput): Promise<number> {
    const { output, prompt } = input;
    const statuses = packageStatus(input.root);
    const selectable = statuses.filter((status) => status.state === 'lacks' || status.state === 'unpublished');
    if (statuses.length === 0 || (selectable.length === 0 && !statuses.some((status) => status.state === 'refused'))) {
      output.success('Nothing to publish');
      return 0;
    }
    if (!prompt.interactive) {
      for (const status of statuses) for (const line of describe(status)) output.line(line);
      if (selectable.length === 0) {
        output.success('Nothing to publish');
        return 0;
      }
      output.error('Choose on a terminal, or run marmeon publish <package> for each of them');
      return 1;
    }
    for (const status of statuses) if (status.state === 'complete' || status.state === 'refused') for (const line of describe(status)) output.line(line);
    if (selectable.length === 0) {
      output.success('Nothing to publish');
      return 0;
    }
    const picked = await prompt.choose('Publish the migrations of which packages?', selectable.map((status) => describe(status)[0]!), { multiple: true });
    if (picked.length === 0) {
      output.line('Nothing published');
      return 0;
    }
    return this.#publish(input, picked.map((index) => selectable[index]!.package), undefined);
  }

  /** Plans every package, then writes: one refusal and nothing is written. */
  #publish(input: CommandInput, packages: readonly string[], module: string | undefined): number {
    const { output } = input;
    const { plans, refusals } = planPublish(input.root, packages, module);
    if (refusals.length > 0) {
      for (const refusal of refusals) output.error(refusal);
      return 1;
    }

    const modules = join(input.root, 'modules');
    const before = appMigrations(modules);
    const count = plans.reduce((sum, plan) => sum + plan.missing.length, 0);
    // One clock for the run, a second apart, behind every migration the app has: a copy can never sort before one that ran.
    const timed = stamps(count, before.newest, before.newestPath, input.root);
    if ('error' in timed) {
      output.error(timed.error);
      return 1;
    }

    // A write that fails after the plan leaves the files before it: say which, so the person can run publish again or remove them.
    const known = new Set([...before.byName.values()].map((found) => found.path));
    const indexes = () => (existsSync(modules) ? readdirSync(modules).map((module) => join(modules, module, 'index.ts')).filter((file) => existsSync(file)) : []);
    const knownIndexes = new Set(indexes());
    const bootstrap = join(input.root, 'bootstrap', 'app.ts');
    const bootstrapBefore = existsSync(bootstrap) ? readFileSync(bootstrap, 'utf8') : undefined;
    const reportWritten = () => {
      const created = [...appMigrations(modules).byName.values()].map((found) => found.path).filter((path) => !known.has(path));
      const files = [...indexes().filter((file) => !knownIndexes.has(file)), ...created].map((path) => relative(input.root, path));
      if (existsSync(bootstrap) && readFileSync(bootstrap, 'utf8') !== bootstrapBefore) files.push(relative(input.root, bootstrap));
      if (files.length > 0) output.error(`Written before it failed: ${files.join(', ')}`);
    };
    let written = 0;
    try {
      for (const plan of plans) {
        if (packages.length === 1) {
          for (const present of plan.present) output.line(`${present.path} is there — skipped`);
        }
        for (const file of plan.missing) {
          const code = publishMigration(input, { name: file.name, contents: file.contents, table: file.name, module: plan.module!, at: timed.stamps[written]!, owner: plan.owner, hint: false });
          if (code !== 0) {
            reportWritten();
            return code;
          }
          written += 1;
        }
      }
    } catch (error) {
      reportWritten();
      throw error;
    }
    if (written === 0) {
      output.success(packages.length === 1 ? `Nothing to publish — every migration of ${packages[0]} is in your app` : 'Nothing to publish — every migration of these packages is in your app');
      return 0;
    }

    output.line('Then: marmeon migrate');
    return 0;
  }
}
