import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application, CommandArgumentsError, type ServiceProviderClass } from '@marmeon/core';
import { findPackage, printable } from '@marmeon/core/internal';
import type { CommandInput } from 'marmeon';
import { assignMigrations, migrationDeclarations, type PackageMigrationFile, type PackageMigrations, show } from '../package-migrations.ts';
import { installRoot } from '../workspace.ts';
import { appMigrations, findMigration, publishMigration, SYSTEM_MODULE, timestamp } from './publish-migration.ts';

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** A valid npm package name: never a path. */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

type Package = NonNullable<ReturnType<typeof findPackage>>;

/**
 * The installed package `name` of the app: in `node_modules` of the app, or of a directory above it up to the first one with a
 * lockfile (a workspace root, where the package manager hoists). Never further — a `node_modules` next to the home directory is
 * not the app's.
 */
function locate(name: string, root: string): Package | undefined {
  const top = installRoot(root);
  // From the real path: the way up from a symlinked app root would pass `top` without ever meeting it.
  const directories: string[] = [];
  for (let dir = realpathSync(root); ; dir = dirname(dir)) {
    directories.push(dir);
    if (dir === top || dirname(dir) === dir) break;
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
 * itself — named `@marmeon/…` by its own `package.json`, and either listed by the app with a registry specification or the
 * package whose own command runs.
 */
function opensSystem(module: string, name: string, pkg: Package, dependencies: Record<string, unknown>, own = false): boolean {
  if (module !== SYSTEM_MODULE || !name.startsWith('@marmeon/') || pkg.json.name !== name) return false;
  // The command of a package that is running cannot be a package the app did not ask for, so its own command opens `system`
  // whatever the specification; the allowlist protects `publish`, which names the package.
  return own || fromRegistry(dependencies[name]);
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
 * Where an installed direct dependency that declares migrations stands in the app. `used` is whether the app has at least one of
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
  /** Warnings: declarations in a direct dependency that does not claim them, and unreadable ones no direct dependency exports. */
  readonly warnings: string[];
  /** Set when reading the declarations failed for every package: nothing can be planned from what is known. */
  readonly failed?: string;
}

/**
 * Reads the direct dependencies of the app and the migrations the service providers `providers` declare for them, assigned in one
 * pass over all of them; undefined when the `package.json` cannot be read — unless `lenient`, where an app without one (not there
 * at all) has no dependencies (a command of a package does not need to list it).
 */
async function inspect(root: string, providers: readonly ServiceProviderClass[], lenient = false): Promise<Context | undefined> {
  let dependencies: Record<string, unknown> = Object.create(null);
  try {
    const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object };
    dependencies = Object.assign(Object.create(null), json.dependencies, json.devDependencies);
  } catch (error) {
    // Only a package.json that is not there is no reason to stop: one that exists and cannot be read is the app's problem.
    if (!lenient || (error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
  }
  const entries = new Map<string, Entry>();
  const shippers = new Map<string, string[]>();
  // A name goes into messages only after PACKAGE_NAME has passed it; `locate` and `findPackage` look nothing else up.
  const installed = new Map<string, Package>();
  for (const name of Object.keys(dependencies).sort()) {
    try {
      const pkg = PACKAGE_NAME.test(name) ? locate(name, root) : undefined;
      if (!pkg) entries.set(name, { kind: 'absent' });
      else installed.set(name, pkg);
    } catch (error) {
      entries.set(name, { kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  const declarations = migrationDeclarations(providers);
  let warnings: string[] = [];
  let failed: string | undefined;
  let results: Awaited<ReturnType<typeof assignMigrations>>['results'] | undefined;
  try {
    const assigned = await assignMigrations([...installed.values()], declarations);
    ({ results } = assigned);
    warnings = [...assigned.unclaimed, ...assigned.unattributed];
  } catch (error) {
    // Every package has its own guard inside, so this is a safety net only.
    failed = error instanceof Error ? error.message : String(error);
    for (const [name, pkg] of installed) entries.set(name, { kind: 'error', message: error instanceof Error ? error.message : String(error), pkg });
  }
  if (results) {
    for (const [name, pkg] of installed) {
      const read = results.get(pkg)!;
      if (!read.ok) entries.set(name, { kind: 'error', message: read.error.message, pkg });
      else if (!read.value) entries.set(name, { kind: 'none' });
      else {
        entries.set(name, { kind: 'ok', pkg, manifest: read.value });
        for (const file of read.value.files) shippers.set(file.name, [...(shippers.get(file.name) ?? []), name]);
      }
    }
  }
  // Entries are shown and checked in the order of the app's dependencies.
  const ordered = new Map([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const modules = join(root, 'modules');
  return { root, modules, dependencies, entries: ordered, app: appMigrations(modules), shippers, warnings, failed };
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
function planOne(context: Context, name: string, pkg: Package, manifest: PackageMigrations, explicit: string | undefined, own = false): { plan: Plan } | { refusal: string } {
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
        if (where !== undefined && !(where === manifest.module && opensSystem(manifest.module, name, pkg, dependencies, own))) {
          return { refusal: elsewhere(file.name, where) };
        }
      }
      module = manifest.module;
      if (existsSync(join(modules, module)) && !opensSystem(module, name, pkg, dependencies, own)) {
        return { refusal: `modules/${module} is your app's — pass --module=<name> to put the tables of ${name} there, or another name.` };
      }
    }
  }
  // `publishMigration` does not check a module it is given.
  if (module !== undefined && !KEBAB.test(module)) return { refusal: 'Pass the module as a kebab-case name: --module=<name>.' };

  return { plan: { package: name, module, owner: module === SYSTEM_MODULE ? undefined : name, missing, present } };
}

/** The package whose own command plans: its name and directory, read from there and not from the app's dependencies. */
interface Own {
  readonly name: string;
  readonly dir: string;
  readonly Provider: ServiceProviderClass;
}

/** The migrations the service provider of the package `own` declares for it; its files count as shipped by it for the collision check. */
async function ownEntry(context: Context, own: Own): Promise<Entry> {
  try {
    const dir = realpathSync(own.dir);
    const pkg: Package = { name: own.name, dir, json: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) };
    const assigned = await assignMigrations([pkg], migrationDeclarations([own.Provider]));
    const read = assigned.results.get(pkg)!;
    if (!read.ok) return { kind: 'error', message: read.error.message, pkg };
    if (!read.value) {
      // The reason the package does not have it: a static that cannot be read, a provider the entry does not export, or none.
      const why = assigned.unattributed[0] ?? assigned.unclaimed[0] ?? `the static migrations of ${show(String(own.Provider.name))} is missing or leads out of the package`;
      return { kind: 'error', message: `${own.name} declares no migrations in its package: ${why.replace(/\.$/, '')}.`, pkg };
    }
    context.warnings.push(...assigned.unclaimed, ...assigned.unattributed);
    for (const file of read.value.files) context.shippers.set(file.name, [...(context.shippers.get(file.name) ?? []), own.name]);
    return { kind: 'ok', pkg, manifest: read.value };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Plans `publish` for `packages` without writing anything: a plan for each, and the reasons any was refused (when there is
 * one, nothing is to be written for any package). `warnings` are declarations a direct dependency does not claim: they never
 * change a plan. `module` is `--module`, for a single package. `own` is the package whose command asks: it need not be a
 * dependency of the app, for the app loaded it to run the command.
 */
export async function planPublish(
  root: string,
  providers: readonly ServiceProviderClass[],
  packages: readonly string[],
  module?: string,
  source: { readonly own?: Own } = {},
): Promise<{ plans: Plan[]; refusals: string[]; warnings: string[] }> {
  const plans: Plan[] = [];
  const refusals: string[] = [];
  const context = await inspect(root, providers, source.own !== undefined);
  if (!context) return { plans, refusals: ['The package.json of your app cannot be read.'], warnings: [] };
  // Without the other packages' declarations the collision check would be blind: the own command refuses rather than plan on.
  if (source.own !== undefined && context.failed !== undefined) return { plans, refusals: [`The migrations of your packages cannot be read: ${context.failed}`], warnings: context.warnings };
  const chosen: { name: string; pkg: Package }[] = [];
  for (const name of new Set(packages)) {
    const isOwn = source.own !== undefined && source.own.name === name;
    if (!isOwn && !(name in context.dependencies)) {
      refusals.push(`${name} is not a dependency of your app — add it first.`);
      continue;
    }
    const entry = isOwn ? await ownEntry(context, source.own!) : context.entries.get(name)!;
    if (entry.kind === 'error') refusals.push(entry.message);
    else if (entry.kind === 'absent') refusals.push(`${name} is not installed in your app — install your dependencies first.`);
    else if (entry.kind === 'none') refusals.push(`${name} ships no migrations.`);
    else {
      const planned = planOne(context, name, entry.pkg, entry.manifest, module, isOwn);
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
      return opensSystem(SYSTEM_MODULE, name, pkg, context.dependencies, source.own?.name === name);
    };
    if (plan.module === SYSTEM_MODULE && framework(first) && framework(plan.package)) continue;
    refusals.push(`${first} and ${plan.package} would both create modules/${plan.module} — publish them one at a time, or pass --module=<name> for each.`);
  }
  return { plans, refusals, warnings: context.warnings };
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

/**
 * Where every installed direct dependency that declares migrations stands in the app, by package name. `warnings` are declarations
 * that no direct dependency claims, and unreadable ones none exports: they change no status.
 */
export async function packageStatus(root: string, providers: readonly ServiceProviderClass[]): Promise<{ statuses: Status[]; warnings: string[] }> {
  const context = await inspect(root, providers);
  if (!context) return { statuses: [], warnings: [] };
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
  return { statuses, warnings: context.warnings };
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

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle(raw: CommandInput): Promise<number> {
    const input: CommandInput = { ...raw, output: safe(raw.output) };
    const name = input.args[0];
    const module = typeof input.options.module === 'string' ? input.options.module : undefined;
    if (input.args.length > 1) {
      throw new CommandArgumentsError('Pass one package at most: marmeon publish [<package>] [--module=<name>] [--check]');
    }
    if (module !== undefined && !KEBAB.test(module)) {
      throw new CommandArgumentsError('--module must be a kebab-case name: marmeon publish <package> --module=<name>');
    }
    if (module !== undefined && name === undefined) {
      throw new CommandArgumentsError('--module needs a package: marmeon publish <package> --module=<name>');
    }

    if (input.options.check === true) return name === undefined ? await this.#checkUsed(input) : await this.#check(input, name, module);
    if (name !== undefined) return await this.#publish(input, [name], module);
    return this.#choose(input);
  }

  /** `--check <package>`: that package, used or not. */
  async #check(input: CommandInput, name: string, module: string | undefined): Promise<number> {
    const { plans, refusals, warnings } = await planPublish(input.root, this.#app.providers, [name], module);
    for (const warning of warnings) input.output.warn(warning);
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
  async #checkUsed(input: CommandInput): Promise<number> {
    let failed = false;
    const { statuses, warnings } = await packageStatus(input.root, this.#app.providers);
    for (const warning of warnings) input.output.warn(warning);
    for (const status of statuses) {
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
    const { statuses, warnings } = await packageStatus(input.root, this.#app.providers);
    for (const warning of warnings) output.warn(warning);
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
    return await this.#publish(input, picked.map((index) => selectable[index]!.package), undefined);
  }

  /** Plans every package, then writes: one refusal and nothing is written. */
  async #publish(input: CommandInput, packages: readonly string[], module: string | undefined): Promise<number> {
    const { plans, refusals, warnings } = await planPublish(input.root, this.#app.providers, packages, module);
    for (const warning of warnings) input.output.warn(warning);
    return write(input, packages, plans, refusals);
  }
}

/**
 * What the `make:*-table` command of a package does: `publish` for that package alone, with its module from `--module`. The
 * package is read from `packageRoot` (a `file:` URL), so the app need not list it, and its name must be a valid package name;
 * its migrations are the `static migrations` of `Provider`, its own service provider. `providers` are the providers of the app
 * (`app.providers`), which tell what its other packages ship. For the commands of the framework's packages only: it opens an existing
 * `system` module whatever the app's specification of the package, which `publish` would not. Returns the exit code; with
 * nothing to write it is 0.
 */
export async function publishOwnMigrations(raw: CommandInput, packageRoot: URL, Provider: ServiceProviderClass, providers: readonly ServiceProviderClass[]): Promise<number> {
  const input: CommandInput = { ...raw, output: safe(raw.output) };
  let dir: string;
  let name: unknown;
  try {
    dir = fileURLToPath(packageRoot);
    name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name;
  } catch {
    input.output.error('The package.json of the package that runs this command cannot be read.');
    return 1;
  }
  if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) {
    input.output.error('The package.json of the package that runs this command has no valid package name.');
    return 1;
  }
  const module = typeof input.options.module === 'string' ? input.options.module : undefined;
  const { plans, refusals, warnings } = await planPublish(input.root, [Provider, ...providers], [name], module, { own: { name, dir, Provider } });
  for (const warning of warnings) input.output.warn(warning);
  return write(input, [name], plans, refusals);
}

/** Writes the plans, in one run: a refusal and nothing is written. */
function write(input: CommandInput, packages: readonly string[], plans: readonly Plan[], refusals: readonly string[]): number {
  const { output } = input;
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
        const code = publishMigration(input, { name: file.name, contents: file.contents, module: plan.module!, at: timed.stamps[written]!, owner: plan.owner, hint: false });
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
