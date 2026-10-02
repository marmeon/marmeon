import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CommandInput } from '@bespokecore/cli';

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The module a driver's tables go to unless `--module` names another (E96). */
export const SYSTEM_MODULE = 'system';

/**
 * Writes a framework driver's migration into an app module (E96: the tables belong to the app, like `make:auth`'s) —
 * `make:cache-table`, `make:session-table`, `make:queue-table`, …. The module is `--module`, by default `system`, which is
 * created (with its `migrations` directory) and registered in `bootstrap/app.ts` when it does not exist yet.
 *
 * Refuses when any module already has a migration with the same name (`*_create_cache_table.ts`): one table, one migration.
 * Returns the exit code.
 */
export function publishMigration(input: CommandInput, migration: { name: string; contents: string; table: string }): number {
  const module = typeof input.options.module === 'string' ? input.options.module : SYSTEM_MODULE;
  if (!KEBAB.test(module)) {
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
  } else if (!/migrations\s*:/.test(readFileSync(join(directory, 'index.ts'), 'utf8'))) {
    input.output.warn(`modules/${module}/index.ts has no \`migrations\` yet — add: migrations: new URL('./migrations/', import.meta.url)`);
  }

  const file = join(directory, 'migrations', `${timestamp(new Date())}_${migration.name}.ts`);
  mkdirSync(join(directory, 'migrations'), { recursive: true });
  writeFileSync(file, migration.contents);
  input.output.success(`Created ${relative(input.root, file)}`);

  if (created) {
    const registered = register(join(input.root, 'bootstrap', 'app.ts'), module);
    if (registered === 'added') input.output.success(`Registered the module in bootstrap/app.ts`);
    else if (registered === 'manual') {
      const variable = module.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
      input.output.line('Register the module in bootstrap/app.ts:');
      input.output.line(`  import ${variable} from '#modules/${module}';`);
      input.output.line(`  modules: [${variable}, …]`);
    }
  }
  input.output.line('Then: bespoke migrate');
  return 0;
}

function findMigration(modules: string, name: string): string | undefined {
  if (!existsSync(modules)) return undefined;
  for (const module of readdirSync(modules)) {
    const directory = join(modules, module, 'migrations');
    if (!existsSync(directory)) continue;
    const file = readdirSync(directory).find((candidate) => candidate.endsWith(`_${name}.ts`));
    if (file) return join(directory, file);
  }
  return undefined;
}

/** `2026_10_02_213000` — the order migrations run in. */
function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}_${pad(date.getUTCMonth() + 1)}_${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** Adds the module to `modules: [...]` of the application definition — or says it cannot. */
function register(file: string, module: string): 'added' | 'manual' {
  if (!existsSync(file)) return 'manual';
  const source = readFileSync(file, 'utf8');
  const variable = module.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
  const modules = /modules:\s*\[([^\]]*)\]/.exec(source);
  const imports = [...source.matchAll(/^import .*;$/gm)];
  if (!modules || imports.length === 0) return 'manual';
  const lastImport = imports.at(-1)!;
  const list = modules[1]!.trim();
  let patched = source.replace(modules[0], `modules: [${list ? `${list}, ${variable}` : variable}]`);
  const at = lastImport.index + lastImport[0].length;
  patched = `${patched.slice(0, at)}\nimport ${variable} from '#modules/${module}';${patched.slice(at)}`;
  writeFileSync(file, patched);
  return 'added';
}

const MODULE = (name: string) => `import { defineModule } from '@bespokecore/core';

// The tables of the framework's drivers (cache, sessions, queue, …): \`bespoke make:*-table\` writes their migrations here.
// They are the app's now — change them like any other migration.
export default defineModule({
  name: '${name}',
  migrations: new URL('./migrations/', import.meta.url),
});
`;
