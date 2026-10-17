import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { editDefinitionFile } from '@marmeon/core';
import { bindingNameOf } from '@marmeon/core/internal';
import type { CommandInput } from 'marmeon';

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The module a driver's tables go to unless `--module` names another. */
export const SYSTEM_MODULE = 'system';

/**
 * Writes a framework driver's migration into an app module (the tables belong to the app, like `make:auth`'s) —
 * `make:cache-table`, `make:session-table`, `make:queue-table`, …. The module is `--module`, by default `system`, which is
 * created (with its `migrations` directory) and registered in `bootstrap/app.ts` when it does not exist yet.
 *
 * Refuses when any module already has a migration with the same name (`*_create_cache_table.ts`): one table, one migration.
 * `module` takes the place of `--module` (an existing module, as it is named on disk); `at` is the timestamp of the file name.
 * Returns the exit code.
 */
export function publishMigration(input: CommandInput, migration: { name: string; contents: string; table: string; module?: string; at?: Date }): number {
  const module = migration.module ?? (typeof input.options.module === 'string' ? input.options.module : SYSTEM_MODULE);
  if (migration.module === undefined && !KEBAB.test(module)) {
    input.output.error('Pass the module as a kebab-case name: --module=<name> (default: system).');
    return 1;
  }
  const modules = join(input.root, 'modules');
  const existing = findMigration(modules, migration.name);
  if (existing) {
    input.output.error(`${relative(input.root, existing)} already exists — the ${migration.table} table has its migration.`);
    return 1;
  }

  const directory = join(modules, module);
  const created = !existsSync(directory);
  if (created) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'index.ts'), MODULE(module));
    input.output.success(`Created ${relative(input.root, join(directory, 'index.ts'))}`);
  } else {
    const edited = editDefinitionFile(join(directory, 'index.ts'), {
      define: { name: 'defineModule', from: '@marmeon/core' },
      key: 'migrations',
      add: { value: "new URL('./migrations/', import.meta.url)" },
    }, `modules/${module}/index.ts`);
    if (edited.status === 'added') input.output.success(`Registered the migrations folder in modules/${module}/index.ts`);
    // A shape the editor cannot read may still register its migrations (a definition built elsewhere): warn only when the file never says so.
    else if (edited.status === 'manual' && !(existsSync(join(directory, 'index.ts')) && /migrations\s*:/.test(readFileSync(join(directory, 'index.ts'), 'utf8')))) {
      input.output.warn(`Not registered — ${edited.reason}`);
      input.output.line("  add: migrations: new URL('./migrations/', import.meta.url)");
    }
  }

  const file = join(directory, 'migrations', `${timestamp(migration.at ?? new Date())}_${migration.name}.ts`);
  mkdirSync(join(directory, 'migrations'), { recursive: true });
  writeFileSync(file, migration.contents);
  input.output.success(`Created ${relative(input.root, file)}`);

  if (created) {
    const registered = register(join(input.root, 'bootstrap', 'app.ts'), module);
    if (registered.status === 'added') input.output.success(`Registered the module in bootstrap/app.ts`);
    else if (registered.status === 'manual') {
      if (registered.reason) input.output.warn(`Not registered — ${registered.reason}`);
      const variable = bindingNameOf(module);
      input.output.line('Register the module in bootstrap/app.ts:');
      input.output.line(`  import ${variable} from '#modules/${module}';`);
      input.output.line(`  modules: [..., ${variable}]`);
    }
  }
  input.output.line('Then: marmeon migrate');
  return 0;
}

/** The path of the migration named `name` (without timestamp) in any module under `modules`. */
export function findMigration(modules: string, name: string): string | undefined {
  if (!existsSync(modules)) return undefined;
  for (const module of readdirSync(modules)) {
    const directory = join(modules, module, 'migrations');
    if (!existsSync(directory)) continue;
    const pattern = new RegExp(`^\\d{4}_\\d{2}_\\d{2}_\\d{6}_${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.ts$`);
    const file = readdirSync(directory).find((candidate) => pattern.test(candidate));
    if (file) return join(directory, file);
  }
  return undefined;
}

/** `2026_10_02_213000` — the order migrations run in. */
function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}_${pad(date.getUTCMonth() + 1)}_${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** Adds the module to the end of `modules` of the application definition — or says why it cannot. */
function register(file: string, module: string): { status: 'added' | 'present' } | { status: 'manual'; reason?: string } {
  if (!existsSync(file)) return { status: 'manual' };
  const edited = editDefinitionFile(file, {
    define: { name: 'defineApplication', from: '@marmeon/core' },
    key: 'modules',
    add: { element: (names) => names[bindingNameOf(module)]!, position: 'last' },
    imports: [{ name: bindingNameOf(module), from: `#modules/${module}`, kind: 'default' }],
  }, 'bootstrap/app.ts');
  return edited.status === 'manual' ? { status: 'manual', reason: edited.reason } : { status: edited.status };
}

const MODULE = (name: string) => `import { defineModule } from '@marmeon/core';

// The tables of the framework's drivers (cache, sessions, queue, …): \`marmeon make:*-table\` writes their migrations here.
// They are the app's now — change them like any other migration.
export default defineModule({
  name: '${name}',
  migrations: new URL('./migrations/', import.meta.url),
});
`;
