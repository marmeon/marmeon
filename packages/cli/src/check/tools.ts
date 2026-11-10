import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { agentsBlock } from '../agents/block.ts';
import { exists, unsafe } from '../agents/files.ts';
import { installedTools, planInstall } from '../agents/install.ts';
import { shippedSkills } from '../agents/skills.ts';
import { syncAgents } from '../agents/sync.ts';
import { findBin, runNode, typecheckApp } from '../typecheck.ts';
import { internalImports } from './internal-imports.ts';
import { lintPresetDrift } from './lint-preset.ts';
import { reportOf, unrunReport, type CheckProblem, type CheckReport } from './report.ts';

/** A check's report, and — for `types` — the type checker's own output, which `marmeon check` shows under the findings. */
export interface CheckRun {
  readonly report: CheckReport;
  readonly raw?: string;
}

/** An error's message without the app's absolute path, so a report holds none. */
export function plainReason(error: unknown, root: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(resolve(root)).join('.');
}

/** The checks that need no app, in the order they are reported. */
export const TOOL_CHECKS = ['types', 'lint', 'internal-imports', 'raw-sql', 'inner-html', 'agents', 'packages'] as const;

/** Type-checks the app with its own TypeScript (`tsc --noEmit`): `skipped` without a `tsconfig.json`, `error` without TypeScript. */
export async function typesCheck(root: string): Promise<CheckRun> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const result = await typecheckApp(root, { pretty: false });
    if (result.status === 'skipped') return { report: unrunReport('types', 'skipped', result.reason, ms()) };
    if (result.status === 'missing') return { report: unrunReport('types', 'error', 'TypeScript is not installed in this app — pnpm add -D typescript', ms()) };
    if (result.status === 'passed') return { report: reportOf('types', [], ms()) };
    const problems: CheckProblem[] = result.diagnostics.map((diagnostic) => ({
      severity: 'error',
      message: diagnostic.message,
      ...(diagnostic.file === undefined ? {} : { file: diagnostic.file }),
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
      ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
      rule: diagnostic.code,
    }));
    // tsc failed but said nothing we could read: the first line of its output is the finding.
    if (problems.length === 0) problems.push({ severity: 'error', message: result.output.trim().split('\n')[0] ?? 'tsc failed', rule: 'tsc' });
    return { report: reportOf('types', problems, ms()), raw: result.output };
  } catch (error) {
    return { report: unrunReport('types', 'error', `tsc could not run: ${plainReason(error, root)}`, ms()) };
  }
}

/** The part of `oxlint --format=json` this reads. */
interface OxlintOutput {
  readonly diagnostics: readonly {
    readonly message: string;
    readonly code?: string;
    readonly severity: string;
    readonly help?: string;
    readonly filename?: string;
    readonly labels?: readonly { readonly span?: { readonly line?: number; readonly column?: number } }[];
  }[];
}

/** Turns oxlint's JSON document (`diagnostics` with `labels[].span.line/column`) into findings; undefined when it is not that. */
export function parseOxlint(stdout: string, root: string): CheckProblem[] | undefined {
  let document: OxlintOutput;
  try {
    document = JSON.parse(stdout) as OxlintOutput;
  } catch {
    return undefined;
  }
  if (!Array.isArray(document?.diagnostics)) return undefined;
  return document.diagnostics.map((diagnostic) => {
    const span = diagnostic.labels?.[0]?.span;
    const file = diagnostic.filename ? relative(resolve(root), resolve(root, diagnostic.filename)).split('\\').join('/') : undefined;
    return {
      severity: diagnostic.severity === 'error' ? 'error' : 'warning',
      message: diagnostic.help ? `${diagnostic.message} — ${diagnostic.help}` : diagnostic.message,
      ...(file === undefined ? {} : { file }),
      ...(typeof span?.line === 'number' ? { line: span.line } : {}),
      ...(typeof span?.column === 'number' ? { column: span.column } : {}),
      ...(diagnostic.code ? { rule: diagnostic.code } : {}),
    };
  });
}

/** Lints the app with its own oxlint, as `pnpm lint` does: `skipped` when oxlint is not installed, `error` when it could not be read. */
export async function lintCheck(root: string): Promise<CheckRun> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const oxlint = findBin(root, 'oxlint', 'oxlint');
  if (!oxlint) return { report: unrunReport('lint', 'skipped', 'oxlint is not installed — pnpm add -D oxlint', ms()) };
  try {
    const { code, stdout, output } = await runNode([oxlint, '--format=json', '--ignore-pattern=**/node_modules/**'], root);
    const problems = parseOxlint(stdout, root);
    // 0: clean, 1: findings. Anything else, or output that is not oxlint's document, is oxlint failing.
    if (!problems || code > 1) {
      return { report: unrunReport('lint', 'error', `oxlint failed (exit ${code}): ${plainReason(output.trim().split('\n')[0] ?? 'no output', root)}`, ms()) };
    }
    return { report: reportOf('lint', [...problems, ...lintPresetDrift(root)], ms()) };
  } catch (error) {
    return { report: unrunReport('lint', 'error', `oxlint could not run: ${plainReason(error, root)}`, ms()) };
  }
}

/** The scan for framework internals (`internalImports`) as a check. */
export function internalImportsCheck(root: string): CheckRun {
  const started = performance.now();
  try {
    return { report: reportOf('internal-imports', internalImports(root), Math.round(performance.now() - started)) };
  } catch (error) {
    return { report: unrunReport('internal-imports', 'error', `the scan failed: ${plainReason(error, root)}`, Math.round(performance.now() - started)) };
  }
}

/**
 * Whether the block of `AGENTS.md` is the one the installed `marmeon` writes for this app, and whether the skills and the entry in `.mcp.json`
 * that `agents:install` wrote are current. Only warns, and writes nothing: the files belong to the app, so no `AGENTS.md` without a
 * finding is `skipped`, and a block that is missing, out of date or marked wrongly is a warning with the command that fixes
 * it. A link that leads nowhere or out of the app is not followed. See docs/check.md#the-agents-block.
 */
export function agentsCheck(root: string): CheckRun {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const install = installProblems(root);
  const problems = [...blockProblems(root), ...install.problems];
  if (problems.length === 0 && !install.installed && !exists(join(root, 'AGENTS.md'))) return { report: unrunReport('agents', 'skipped', 'no AGENTS.md', ms()) };
  return { report: reportOf('agents', problems, ms()) };
}

/** No `AGENTS.md` is the app's choice, not a finding. */
function blockProblems(root: string): CheckProblem[] {
  const file = join(root, 'AGENTS.md');
  const docs = 'docs/agents.md#keeping-the-block-current';
  const warn = (message: string, fix?: string): CheckProblem[] => [{ severity: 'warning', message, file: 'AGENTS.md', ...(fix === undefined ? {} : { fix }), docs }];
  try {
    if (!exists(file)) return [];
    const problem = unsafe(root, file);
    if (problem !== undefined) return warn(problem.replace(/ Nothing was written\.$/, ' It was not read.'));
    // What cannot be read is reported once, by `installProblems`; no block is judged against a guess.
    const tools = installedTools(root);
    if (!tools.ok) return [];
    const result = syncAgents(readFileSync(realpathSync.native(file), 'utf8'), agentsBlock(tools.value));
    if (!result.ok) return warn(`${result.error.message}`);
    const { change } = result.value;
    if (change === 'unchanged') return [];
    return warn(
      change === 'appended' ? 'AGENTS.md has no marmeon block — marmeon agents:sync' : "AGENTS.md's marmeon block is out of date — marmeon agents:sync",
      'marmeon agents:sync',
    );
  } catch (error) {
    return warn(`AGENTS.md could not be read: ${plainReason(error, root)}`);
  }
}

/**
 * What `agents:install` would change, judged only where something is installed: a skill with the mark or an entry `marmeon` in
 * `.mcp.json`. The plan reads no target of a link out of the app, and nothing is written.
 */
function installProblems(root: string): { problems: CheckProblem[]; installed: boolean } {
  const docs = 'docs/agents.md#skills-and-the-mcp-server';
  const none = { problems: [], installed: false };
  try {
    // An unreadable file is a warning, not a guess; an app that installed nothing gets no message.
    const found = installedTools(root);
    if (!found.ok) return { installed: true, problems: [{ severity: 'warning', message: found.error.message.replace(/ Nothing was written\.$/, ' It was not read.'), docs }] };
    const skillsInstalled = found.value.skillFolder !== undefined;
    if (!skillsInstalled && !found.value.mcp) return none;
    const planned = planInstall(root, skillsInstalled ? shippedSkills() : [], { shared: false, mcp: true });
    if (!planned.ok) {
      const message = planned.error.message.replace(/ Nothing was written\.$/, ' It was not changed.');
      return { installed: true, problems: [{ severity: 'warning', message, ...(planned.error.path === undefined ? {} : { file: planned.error.path }), docs }] };
    }
    return {
      installed: true,
      problems: planned.value.steps
        .filter((step) => step.change !== 'unchanged')
        .map((step): CheckProblem => ({
          severity: 'warning',
          message: `${step.path} is ${step.change === 'create' ? 'missing' : 'out of date'} — marmeon agents:install`,
          file: step.path,
          fix: 'marmeon agents:install',
          docs,
        })),
    };
  } catch (error) {
    return { installed: true, problems: [{ severity: 'warning', message: `The installed skills could not be read: ${plainReason(error, root)}`, docs }] };
  }
}
