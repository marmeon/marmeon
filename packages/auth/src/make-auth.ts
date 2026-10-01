import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandInput } from '@bespokecore/cli';

/** The module templates, per UI adapter (E30): `stubs/<adapter>/modules/auth`. */
export const STUBS = fileURLToPath(new URL('../stubs/', import.meta.url));

/** What the generated module imports — reported when the app lacks it. */
const NEEDED = ['@bespokecore/auth', '@bespokecore/cache', '@bespokecore/database', '@bespokecore/mail', '@bespokecore/react', '@bespokecore/router', '@bespokecore/session', 'mjml', 'valibot'];

/**
 * `bespoke make:auth` (Laravel Breeze): writes a complete auth module into the app — sign-in, registration,
 * remember-me, password reset, e-mail verification, password confirmation, API tokens, with views,
 * mails, migrations and tests. The code belongs to the app from then on; the mechanics stay in
 * @bespokecore/auth.
 */
export class MakeAuthCommand {
  static command = 'make:auth';
  static description = 'Create the auth module (sign-in, registration, reset, verification, API tokens) — yours to change';
  static usage = '[--adapter=react] [--force]';
  static options = { force: { type: 'boolean' }, adapter: { type: 'string' } } as const;

  async handle(input: CommandInput): Promise<number> {
    const adapter = typeof input.options.adapter === 'string' ? input.options.adapter : 'react';
    const source = join(STUBS, adapter, 'modules', 'auth');
    if (!/^[a-z]+$/.test(adapter) || !existsSync(source)) {
      input.output.error(`There are no auth templates for the UI adapter "${adapter}". Known: ${readdirSync(STUBS).join(', ')}.`);
      return 1;
    }
    const target = join(input.root, 'modules', 'auth');
    if (existsSync(target) && input.options.force !== true) {
      input.output.error('modules/auth already exists. It is yours now — pass --force to overwrite it with the templates.');
      return 1;
    }
    if (!existsSync(join(input.root, 'config', 'app.ts'))) {
      input.output.error('The templates need config/app.ts exporting AppConfig (APP_NAME, APP_URL) — the app skeleton has one.');
      return 1;
    }

    cpSync(source, target, { recursive: true, force: true });
    const files = (readdirSync(target, { recursive: true }) as string[]).filter((file) => /\.\w+$/.test(file));
    input.output.success(`Created modules/auth (${files.length} files)`);

    const registered = register(join(input.root, 'bootstrap', 'app.ts'));
    if (registered === 'added') input.output.success('Registered the module in bootstrap/app.ts');
    else if (registered === 'manual') {
      input.output.line('Register the module in bootstrap/app.ts:');
      input.output.line("  import auth from '#modules/auth';");
      input.output.line('  modules: [auth, …]');
    }

    const missing = missingDependencies(input.root);
    // The module's routes and views into bootstrap/routes.ts — a fresh process, as this one booted without the module.
    const typed = missing.length === 0 && registered !== 'manual' && (await input.spawn('route:types')) === 0;
    input.output.line();
    if (missing.length > 0) input.output.line(`Install what the module uses: pnpm add ${missing.join(' ')}`);
    if (!typed) input.output.line('Then: bespoke route:types — it writes the routes and views of the module into bootstrap/routes.ts.');
    input.output.line('Then: bespoke migrate — and set MAIL_* in .env (development writes mails to the log).');
    input.output.line(`Tests: ${relative(input.root, join(target, 'auth.test.ts'))}`);
    return 0;
  }
}

/** Adds `auth` to `modules: [...]` of the application definition — or says it cannot. */
function register(file: string): 'added' | 'present' | 'manual' {
  if (!existsSync(file)) return 'manual';
  const source = readFileSync(file, 'utf8');
  if (/from '#modules\/auth'/.test(source)) return 'present';
  const modules = /modules:\s*\[([^\]]*)\]/.exec(source);
  const imports = [...source.matchAll(/^import .*;$/gm)];
  if (!modules || imports.length === 0) return 'manual';
  const lastImport = imports.at(-1)!;
  const list = modules[1]!.trim();
  let patched = source.replace(modules[0], `modules: [${list ? `auth, ${list}` : 'auth'}]`);
  const at = lastImport.index + lastImport[0].length;
  patched = `${patched.slice(0, at)}\nimport auth from '#modules/auth';${patched.slice(at)}`;
  writeFileSync(file, patched);
  return 'added';
}

function missingDependencies(root: string): string[] {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return NEEDED;
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const have = { ...pkg.dependencies, ...pkg.devDependencies };
  return NEEDED.filter((name) => !(name in have));
}
