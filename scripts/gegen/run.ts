/**
 * `pnpm gegen` — the Gegenproben in the repository (E188, Wave 9; revises E112's throwaway scripts). Every case takes a measure out
 * (a patch), runs a test or a command and expects it to turn red for the measure's reason; then the patch is taken back. Never part
 * of `pnpm run ci` (`scripts/ci.test.ts` keeps it out): it patches the working tree.
 *
 *   pnpm gegen --list                 # waves, steps, cases
 *   pnpm gegen w9                     # every Gegenprobe of the wave (scripts/gegen/w9/*.ts, in step order)
 *   pnpm gegen w9/s05                 # one step
 *   pnpm gegen w9/s05 G3 G3b          # some cases
 *   pnpm gegen w9 --control           # without the patches: every case must be GREEN (the control)
 *   pnpm gegen w9 --repo <checkout>   # against another checkout (the acceptance in a fresh git worktree)
 *
 * Per case: red (reason matches) · GREEN (the measure has no effect!) · red for another reason · 0 tests (aborted) · anchor problem.
 * Exit 0 when every case is as expected, 1 when one is not, 2 for a usage error, 3 when the working tree could not be put back exactly
 * (stop and look: `git status`), 130/143 after SIGINT/SIGTERM (the patches are taken back first).
 *
 * The guarantees: anchors are checked before anything is written (every `find` exactly once — otherwise nothing is touched); a case's
 * patches are applied all or none; they are taken back in reverse order in `finally` and on SIGINT/SIGTERM; afterwards every patched
 * file has its old hash and `git status --porcelain` is what it was before the run — otherwise the run stops loudly. A Vitest run in
 * which no test ran (a name filter that matches nothing) is "0 tests", never "red" or "green"; the name is escaped for `-t` (a regex).
 * The reason is matched against the failures' messages (the lines before the stack) or the command's output — never a matcher's name.
 *
 * `--cases <dir>` reads the waves from another directory (the runner's own tests); `--verbose` prints every run's output.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { CommandRun, GegenCase, Gegenproben, GegenPatch, VitestRun } from './define.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ownRoot = resolve(here, '../..');
const DEFAULT_TIMEOUT = 10 * 60_000;

/** `vitest -t` takes a regular expression: a name with `()` or `.` would match something else, or nothing. */
export const escapeTestName = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- Steps ------------------------------------------------------------------------------------------------------------------

export interface Step {
  /** `w9` */
  readonly wave: string;
  /** `s01` */
  readonly key: string;
  readonly file: string;
  readonly definition: Gegenproben;
}

const byNumber = (a: string, b: string) => Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0) || a.localeCompare(b);

function stepFiles(casesDir: string): { wave: string; key: string; file: string }[] {
  if (!existsSync(casesDir)) return [];
  const found: { wave: string; key: string; file: string }[] = [];
  for (const wave of readdirSync(casesDir).filter((name) => /^w\d+$/.test(name) && statSync(join(casesDir, name)).isDirectory()).sort(byNumber)) {
    for (const name of readdirSync(join(casesDir, wave)).filter((file) => /^s\d+[a-z]?(-.*)?\.ts$/.test(file) && !file.includes('.test.')).sort(byNumber)) {
      found.push({ wave, key: /^s\d+[a-z]?/.exec(name)![0], file: join(casesDir, wave, name) });
    }
  }
  return found;
}

/** The steps a selector names: `w9` (the wave) or `w9/s01` (one step); none selects every wave. */
export async function loadSteps(casesDir: string, selector?: string): Promise<Step[]> {
  const [wave, key] = selector === undefined ? [] : selector.split('/');
  const files = stepFiles(casesDir).filter((step) => (wave === undefined || step.wave === wave) && (key === undefined || step.key === key));
  if (selector !== undefined && files.length === 0) throw new UsageError(`No Gegenproben for "${selector}" in ${casesDir} (pnpm gegen --list).`);
  const steps: Step[] = [];
  for (const step of files) {
    const definition = ((await import(pathToFileURL(step.file).href)) as { default?: Gegenproben }).default;
    if (!definition || !Array.isArray(definition.cases)) throw new UsageError(`${step.file} has no default export of defineGegenproben(…).`);
    steps.push({ ...step, definition });
  }
  return steps;
}

class UsageError extends Error {}

// --- The working tree ---------------------------------------------------------------------------------------------------------

const hash = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');

/** What a run starts from: the repository's `git status`, and the hash of every file a patch touches. */
interface Snapshot {
  readonly repo: string;
  readonly status: string;
  readonly hashes: Map<string, string>;
}

function gitStatus(repo: string): string {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new UsageError(`git status in ${repo} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The writes still to take back (in reverse order), for `finally` and the signal handlers alike. */
const applied: { file: string; before: Buffer }[] = [];
let snapshot: Snapshot | undefined;
let running: ChildProcess | undefined;

class TreeError extends Error {}

/** Takes every write back, newest first, then checks the files' hashes and `git status` against the snapshot. */
function restore(): void {
  while (applied.length > 0) {
    const { file, before } = applied.pop()!;
    writeFileSync(file, before);
  }
  if (!snapshot) return;
  const changed = [...snapshot.hashes].filter(([file, before]) => !existsSync(file) || hash(readFileSync(file)) !== before).map(([file]) => file);
  if (changed.length > 0) throw new TreeError(`not restored exactly: ${changed.join(', ')}`);
  const status = gitStatus(snapshot.repo);
  if (status !== snapshot.status) {
    throw new TreeError(`git status changed during the run — something wrote a file no patch touched:\n--- before\n${snapshot.status || '(clean)\n'}--- after\n${status || '(clean)\n'}`);
  }
}

type Planned = { writes: Map<string, string> } | { problem: string };

/** Every anchor exactly once, in order (a file patched twice: the second anchor in the first patch's result) — nothing is written. */
export function planPatches(repo: string, patches: readonly GegenPatch[]): Planned {
  const writes = new Map<string, string>();
  for (const patch of patches) {
    const file = resolve(repo, patch.file);
    if (!writes.has(file) && !existsSync(file)) return { problem: `${patch.file} does not exist` };
    const text = writes.get(file) ?? readFileSync(file, 'utf8');
    const count = text.split(patch.find).length - 1;
    if (count !== 1) {
      const anchor = patch.find.length > 60 ? `${patch.find.slice(0, 57)}…` : patch.find;
      return { problem: `${patch.file}: the anchor ${JSON.stringify(anchor)} occurs ${count} times — it must occur exactly once` };
    }
    writes.set(file, text.replace(patch.find, () => patch.replace));
  }
  return { writes };
}

function apply(writes: Map<string, string>): void {
  for (const [file, after] of writes) {
    applied.push({ file, before: readFileSync(file) });
    writeFileSync(file, after);
  }
}

// --- Runs ---------------------------------------------------------------------------------------------------------------------

interface Outcome {
  readonly kind: 'green' | 'red' | 'zero' | 'timeout';
  /** What `expect` is matched against: the failures' messages, or the command's output. */
  readonly reason: string;
  /** One line to show: the first failure's first line, or the command's line that matched. */
  readonly headline: string;
  readonly output: string;
  /** Tests that ran (Vitest: passed + failed — skipped ones do not count). */
  readonly tests?: number;
}

/** The environment of a run: no Vitest worker variables of a Vitest the runner itself may run in. */
function environment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const [key, value] of Object.entries(process.env)) if (!/^(VITEST|TINYPOOL|FORCE_COLOR$|NO_COLOR$)/.test(key)) env[key] = value;
  return { ...env, ...extra };
}

function spawnRun(repo: string, command: readonly string[], run: VitestRun | CommandRun): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const [file, ...args] = command as [string, ...string[]];
    // A process group of its own: a stop (timeout, SIGINT) ends the whole tree — pnpm, Vitest, its workers, a server.
    const child = spawn(file, args, { cwd: repo, env: environment(run.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running = child;
    let output = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, run.timeout ?? DEFAULT_TIMEOUT);
    child.on('error', (error) => {
      output += `\n${file} could not start: ${error.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      running = undefined;
      resolvePromise({ code, output, timedOut });
    });
  });
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** The lines of an error before its stack: what a reader of the failure sees first. */
function messageOf(failure: string): string {
  const lines = failure.split('\n');
  const stack = lines.findIndex((line) => /^\s+at /.test(line));
  return (stack === -1 ? lines : lines.slice(0, stack)).join('\n').trim();
}

interface VitestReport {
  numPassedTests: number;
  numFailedTests: number;
  numFailedTestSuites: number;
  testResults: { name: string; status: string; message: string; assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[];
}

async function execute(repo: string, run: VitestRun | CommandRun): Promise<Outcome> {
  if ('command' in run) {
    const { code, output, timedOut } = await spawnRun(repo, run.command, run);
    if (timedOut) return { kind: 'timeout', reason: output, headline: `stopped after ${run.timeout ?? DEFAULT_TIMEOUT} ms`, output };
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    return { kind: code === 0 ? 'green' : 'red', reason: output, headline: lines.at(-1) ?? `exit ${code}`, output };
  }
  const dir = mkdtempSync(join(tmpdir(), 'marmeon-gegen-'));
  try {
    const json = join(dir, 'report.json');
    const files = typeof run.vitest === 'string' ? [run.vitest] : [...run.vitest];
    const filter = run.name === undefined ? [] : ['-t', escapeTestName(run.name)];
    const { code, output, timedOut } = await spawnRun(repo, ['pnpm', 'test', ...files, ...filter, '--reporter=json', `--outputFile=${json}`], run);
    if (timedOut) return { kind: 'timeout', reason: output, headline: `stopped after ${run.timeout ?? DEFAULT_TIMEOUT} ms`, output };
    const report = existsSync(json) ? (JSON.parse(readFileSync(json, 'utf8')) as VitestReport) : undefined;
    const tests = report ? report.numPassedTests + report.numFailedTests : 0;
    const failures = (report?.testResults ?? []).flatMap((file) => [
      ...file.assertionResults.filter((test) => test.status === 'failed').flatMap((test) => test.failureMessages.map(messageOf)),
      ...(file.status === 'failed' && file.message ? [messageOf(file.message)] : []),
    ]);
    const failed = code !== 0 || failures.length > 0 || (report?.numFailedTestSuites ?? 0) > 0;
    // Nothing failed and nothing ran: the filter matched no test (or the file has none) — never counted as red or green.
    if (!failed && tests === 0) return { kind: 'zero', reason: '', headline: `0 tests ran (${files.join(' ')}${run.name ? ` -t ${JSON.stringify(run.name)}` : ''})`, output, tests };
    if (!failed) return { kind: 'green', reason: '', headline: `${tests} test(s) green`, output, tests };
    // Red without a failed test (a global setup, the process): the output is the reason.
    const reason = failures.length > 0 ? failures.join('\n') : output;
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    const headline = failures[0]?.split('\n').find((line) => line.trim()) ?? lines.find((line) => /Error\b/.test(line)) ?? lines.at(-1) ?? `exit ${code}`;
    return { kind: 'red', reason, headline: headline.trim(), output, tests };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Cases --------------------------------------------------------------------------------------------------------------------

type Verdict = 'red' | 'masking' | 'green' | 'green-in-control' | 'unexpected-green' | 'wrong-reason' | 'red-probe' | 'red-in-control' | 'zero' | 'timeout' | 'anchor';

interface CaseResult {
  readonly step: Step;
  readonly entry: GegenCase;
  readonly verdict: Verdict;
  readonly expected: boolean;
  readonly line: string;
}

const LABEL: Record<Verdict, string> = {
  red: 'red (reason matches)',
  masking: 'green, as a masking probe must be',
  green: 'green',
  'green-in-control': 'green (control)',
  'unexpected-green': 'GREEN — the measure has no effect!',
  'wrong-reason': 'red for another reason',
  'red-probe': 'red — a masking probe must stay green',
  'red-in-control': 'RED in the control (without the patch)',
  zero: '0 tests ran (aborted — check the name filter)',
  timeout: 'stopped: it ran out of time',
  anchor: 'anchor problem — nothing was patched',
};

function verdictOf(entry: GegenCase, outcome: Outcome, control: boolean): Verdict {
  if (outcome.kind === 'zero') return 'zero';
  if (outcome.kind === 'timeout') return 'timeout';
  if (control) return outcome.kind === 'green' ? 'green-in-control' : 'red-in-control';
  if (entry.expectGreen) return outcome.kind === 'green' ? 'masking' : 'red-probe';
  if (outcome.kind === 'green') return 'unexpected-green';
  return entry.expect!.test(outcome.reason) ? 'red' : 'wrong-reason';
}

const EXPECTED = new Set<Verdict>(['red', 'masking', 'green-in-control']);

async function runCase(repo: string, step: Step, entry: GegenCase, { control, verbose }: { control: boolean; verbose: boolean }): Promise<CaseResult> {
  console.log(`▶ ${step.definition.step} ${entry.id} — ${entry.title}${entry.expectGreen ? ' (masking probe)' : ''}${control ? ' [control]' : ''}`);
  let outcome: Outcome;
  if (control) {
    outcome = await execute(repo, entry.run);
  } else {
    const planned = planPatches(repo, entry.patch);
    if ('problem' in planned) {
      const line = `${LABEL.anchor}: ${planned.problem}`;
      console.log(`  ✗ ${line}`);
      return { step, entry, verdict: 'anchor', expected: false, line };
    }
    for (const file of planned.writes.keys()) if (!snapshot!.hashes.has(file)) snapshot!.hashes.set(file, hash(readFileSync(file)));
    try {
      apply(planned.writes);
      outcome = await execute(repo, entry.run);
    } finally {
      restore();
    }
  }
  const verdict = verdictOf(entry, outcome, control);
  const expected = EXPECTED.has(verdict);
  const line = `${LABEL[verdict]}: ${outcome.headline}`;
  console.log(`  ${expected ? '✓' : '✗'} ${line}`);
  if (verdict === 'wrong-reason') console.log(`    expected ${entry.expect}`);
  if ((!expected || verbose) && outcome.output.trim()) {
    const tail = outcome.output.trimEnd().split('\n').slice(verbose ? 0 : -25);
    console.log(tail.map((text) => `    │ ${text}`).join('\n'));
  }
  return { step, entry, verdict, expected, line };
}

function summarize(results: readonly CaseResult[], control: boolean): void {
  console.log('\ngegen summary');
  const steps = [...new Set(results.map((result) => result.step))];
  for (const step of steps) {
    const mine = results.filter((result) => result.step === step);
    if (control) {
      const green = mine.filter((result) => result.verdict === 'green-in-control').length;
      console.log(`  ${step.definition.step} control: ${green} of ${mine.length} green`);
    } else {
      const reds = mine.filter((result) => !result.entry.expectGreen);
      const probes = mine.filter((result) => result.entry.expectGreen);
      const pairs = [...new Set(reds.filter((result) => result.entry.masks !== undefined).map((result) => [result.entry.id, result.entry.masks!].sort().join('↔')))];
      console.log(
        `  ${step.definition.step}: ${reds.filter((result) => result.verdict === 'red').length} of ${reds.length} red (reason matches), ` +
          `${probes.filter((result) => result.verdict === 'masking').length} of ${probes.length} masking probes as expected` +
          (pairs.length > 0 ? `; masking pairs ${pairs.join(', ')}` : ''),
      );
    }
    for (const result of mine.filter((each) => !each.expected)) console.log(`    ✗ ${result.entry.id}: ${result.line}`);
  }
  const off = results.filter((result) => !result.expected).length;
  console.log(`  ${off === 0 ? 'all' : `${results.length - off} of`} ${results.length} case(s) as expected`);
}

// --- The command --------------------------------------------------------------------------------------------------------------

function list(steps: readonly Step[]): void {
  let wave = '';
  for (const step of steps) {
    if (step.wave !== wave) console.log(`${(wave = step.wave)}`);
    console.log(`  ${step.wave}/${step.key}  ${step.definition.step} — ${step.definition.cases.length} case(s)  (${step.file.slice(ownRoot.length + 1)})`);
    for (const entry of step.definition.cases) {
      const marks = [entry.expectGreen ? 'masking probe' : '', entry.masks ? `pair with ${entry.masks}` : ''].filter(Boolean).join(', ');
      console.log(`    ${entry.id.padEnd(5)} ${entry.title}${marks ? ` (${marks})` : ''}`);
    }
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      list: { type: 'boolean', default: false },
      control: { type: 'boolean', default: false },
      repo: { type: 'string' },
      cases: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const casesDir = resolve(values.cases ?? here);
  if (values.help) {
    console.log('Usage: pnpm gegen --list | pnpm gegen <wave>[/<step>] [case ids…] [--control] [--repo <checkout>] [--verbose]');
    return 0;
  }
  if (values.list) {
    list(await loadSteps(casesDir, positionals[0]));
    return 0;
  }
  const [selector, ...ids] = positionals;
  if (selector === undefined) throw new UsageError('Which Gegenproben? e.g. pnpm gegen w9/s01 (pnpm gegen --list).');
  const repo = resolve(values.repo ?? ownRoot);
  if (!existsSync(join(repo, '.git'))) throw new UsageError(`${repo} is not a git checkout.`);
  const steps = await loadSteps(casesDir, selector);
  const selected = steps.flatMap((step) => step.definition.cases.filter((entry) => ids.length === 0 || ids.includes(entry.id)).map((entry) => ({ step, entry })));
  const unknown = ids.filter((id) => !steps.some((step) => step.definition.cases.some((entry) => entry.id === id)));
  if (unknown.length > 0) throw new UsageError(`Unknown case(s) ${unknown.join(', ')} in ${selector}.`);

  snapshot = { repo, status: gitStatus(repo), hashes: new Map() };
  console.log(`gegen: ${selected.length} case(s) in ${repo}${values.control ? ' — control: without the patches, every case must be green' : ''}\n`);
  const results: CaseResult[] = [];
  for (const { step, entry } of selected) results.push(await runCase(repo, step, entry, { control: values.control, verbose: values.verbose }));
  restore(); // the control too: a run that wrote into the tree fails here
  summarize(results, values.control);
  return results.every((result) => result.expected) ? 0 : 1;
}

/** SIGINT/SIGTERM: the run's process group is ended, the patches are taken back and checked, then the runner exits. */
function onSignals(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (running) killGroup(running);
      const files = applied.length;
      try {
        restore();
        console.error(`\ngegen: ${signal} — stopped; ${files} patched file(s) taken back, the working tree is as before.`);
      } catch (error) {
        console.error(`\ngegen: ${signal} — stopped, but the working tree is NOT as before: ${(error as Error).message}`);
      }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

if (import.meta.main) {
  onSignals();
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`gegen: ${error.message}`);
      process.exitCode = 2;
    } else if (error instanceof TreeError) {
      console.error(`\ngegen: STOPPED — ${error.message}\nLook at \`git status\` before anything else.`);
      process.exitCode = 3;
    } else {
      throw error;
    }
  }
}
