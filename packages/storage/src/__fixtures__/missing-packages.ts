import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');

/**
 * A resolve hook that makes each of `names` (and their subpaths) fail the way an uninstalled package does; returns its path. With
 * `importedFrom`, only a module whose URL contains it is refused (the script that boots the app still loads the package itself).
 */
export function writeMissingHook(directory: string, names: readonly string[], importedFrom = ''): string {
  const file = join(directory, `hook-${names.length}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    file,
    `
import { registerHooks } from 'node:module';
const missing = ${JSON.stringify(names)};
registerHooks({
  resolve(specifier, context, next) {
    if (String(context.parentURL).includes(${JSON.stringify(importedFrom)}) && missing.some((name) => specifier === name || specifier.startsWith(name + '/'))) {
      console.log('refused ' + specifier);
      throw Object.assign(new Error("Cannot find package '" + specifier + "' imported from " + context.parentURL), { code: 'ERR_MODULE_NOT_FOUND' });
    }
    return next(specifier, context);
  },
});
`,
  );
  return file;
}

/** Runs `body` (an async module body) in a fresh Node process under the hook; a hanging child is killed and fails. */
export function runWithHook(hook: string, body: string): { status: number | null; stdout: string; stderr: string } {
  const code = `try { ${body} } catch (error) { console.error(error.code, error.stack); process.exit(1); }`;
  const run = spawnSync(process.execPath, ['--conditions=@marmeon/source', '--import', '@marmeon/core/register', '--import', pathToFileURL(hook).href, '--input-type=module', '-e', code], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
