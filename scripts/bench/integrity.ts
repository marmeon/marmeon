/**
 * Before a measurement: can the checkout still import what a measured process imports? The worktrees of `pnpm bench` live under
 * `$TMPDIR/marmeon-bench/` and are kept between runs — and macOS cleans `$TMPDIR` file by file, so a snapshot's `node_modules` can
 * lose files while its lockfile marker stays (`ERR_MODULE_NOT_FOUND` in the middle of a run). A smoke test imports the
 * modules first; a missing module removes every `node_modules` of the checkout and installs again, once.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** How a checkout is probed: Node with these arguments in `cwd`, importing every specifier. */
export interface ImportProbe {
  readonly cwd: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly specifiers: readonly string[];
}

/** What Node says when a package or a file of one is gone. */
export const MISSING_MODULE = /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/;

/** `undefined` when every specifier imports; otherwise Node's output. */
export function importProblem(probe: ImportProbe): string | undefined {
  const code = probe.specifiers.map((specifier) => `await import(${JSON.stringify(specifier)});`).join('\n');
  const result = spawnSync(process.execPath, [...(probe.args ?? []), '--input-type=module', '-e', code], {
    cwd: probe.cwd,
    env: probe.env ?? process.env,
    encoding: 'utf8',
  });
  if (result.status === 0) return undefined;
  return `${result.stderr}${result.stdout}`.trim() || `node exited with ${result.status ?? result.signal}`;
}

/** Every `node_modules` of a pnpm checkout: the root's and each workspace package's (`packages/*`, `apps/*`). */
export function removeNodeModules(checkout: string): void {
  const dirs = [checkout];
  for (const group of ['packages', 'apps']) {
    if (!existsSync(join(checkout, group))) continue;
    for (const entry of readdirSync(join(checkout, group), { withFileTypes: true })) if (entry.isDirectory()) dirs.push(join(checkout, group, entry.name));
  }
  for (const dir of dirs) rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
}

/** Node's sentence ("Cannot find module '…' imported from …"), not the line of its stack that throws. */
const firstLine = (text: string) => {
  const lines = text.split('\n');
  return (lines.find((line) => /Cannot find (?:package|module)/.test(line)) ?? lines.find((line) => MISSING_MODULE.test(line)) ?? lines[0]!).trim();
};

/**
 * Makes sure `checkout` can import what `probe` names: a missing module means damaged `node_modules` — they are removed and
 * installed again (`install`), then probed once more. Any other failure, or one that a fresh install does not fix, throws.
 */
export function ensureImportable(checkout: string, probe: ImportProbe, { install, log }: { install: (checkout: string) => void; log: (line: string) => void }): void {
  const problem = importProblem(probe);
  if (problem === undefined) return;
  if (!MISSING_MODULE.test(problem)) throw new Error(`${checkout} cannot import what the measurement needs:\n${problem}`);
  log(`  ${checkout}: ${firstLine(problem)} — damaged node_modules ($TMPDIR is cleaned file by file); removing them and installing again`);
  removeNodeModules(checkout);
  install(checkout);
  const again = importProblem(probe);
  if (again !== undefined) throw new Error(`${checkout} still cannot import what the measurement needs after a fresh install:\n${again}`);
}
