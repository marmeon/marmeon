/**
 * `pnpm zizmor` — zizmor over the workflows and Dependabot's configuration, a part of `pnpm run ci`. CI runs it online in the job
 * `zizmor` of ci.yml (the action installs the version pinned there); here it runs with `--offline` (no audit that needs the network, no token read from the environment). Without
 * zizmor installed it exits 75: skipped, not green (`scripts/ci.ts`). The rules: `.github/zizmor.yml`; CONTRIBUTING.md, "The
 * workflows: zizmor".
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** What `zizmor` gets here: the regular persona, as in CI, over the repository's own workflows and `.github/dependabot.yml`. */
export const ZIZMOR_ARGS = ['--persona=regular', '--offline', '.'] as const;

/** The exit code of a run that could not happen here, as in `scripts/ci.ts`. */
const SKIPPED_EXIT = 75;

/** The `version:` the `zizmor` job of ci.yml hands to the action; `undefined` when there is no such job or version. */
export function zizmorVersion(ciYml: string): string | undefined {
  const job = /^ {2}zizmor:[ \t]*\n((?:(?: {3,}.*)?\n)*)/m.exec(ciYml)?.[1];
  return job === undefined ? undefined : /^\s+version:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/m.exec(job)?.[1];
}

const root = fileURLToPath(new URL('..', import.meta.url));

/** Runs zizmor; the exit code of this script. */
function main(): number {
  const wanted = zizmorVersion(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const found = spawnSync('zizmor', ['--version'], { encoding: 'utf8' });
  if (found.error && (found.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error(`zizmor could not be started: ${found.error.message}`);
    return 1;
  }
  if (found.error) {
    const version = wanted ?? '<version>';
    console.error(
      `zizmor is not installed — skipped. Install it: brew install zizmor, uv tool install zizmor==${version} or pipx install zizmor==${version}.`,
    );
    return SKIPPED_EXIT;
  }
  const installed = /\b(\d+\.\d+\.\d+)\b/.exec(found.stdout)?.[1];
  if (wanted !== undefined && installed !== wanted) {
    console.error(`zizmor ${installed ?? '(unknown version)'} is installed, ci.yml runs ${wanted} — the findings may differ.`);
  }
  const result = spawnSync('zizmor', ZIZMOR_ARGS, { cwd: root, stdio: 'inherit' });
  return result.error ? 1 : (result.status ?? 1);
}

if (import.meta.main) process.exitCode = main();
