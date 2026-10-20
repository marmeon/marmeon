import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { AGENTS_BLOCK } from '../agents/block.ts';
import { exists, unsafe } from '../agents/files.ts';
import { syncAgents } from '../agents/sync.ts';
import { findBin, runNode, typecheckApp } from '../typecheck.ts';
import { internalImports } from './internal-imports.ts';
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
export const TOOL_CHECKS = ['types', 'lint', 'internal-imports', 'raw-sql', 'inner-html', 'agents'] as const;

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
    return { report: reportOf('lint', problems, ms()) };
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
 * Whether the block of `AGENTS.md` is the one the installed `marmeon` writes. Only warns, and writes nothing: the file belongs to
 * the app, so no `AGENTS.md` is `skipped`, and a block that is missing, out of date or marked wrongly is a warning with the command
 * that fixes it. A link that leads nowhere or out of the app is not followed. See docs/check.md#the-agents-block.
 */
export function agentsCheck(root: string): CheckRun {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const file = join(root, 'AGENTS.md');
  const docs = 'docs/agents.md#keeping-the-block-current';
  const warn = (message: string, fix?: string): CheckRun => ({
    report: reportOf('agents', [{ severity: 'warning', message, file: 'AGENTS.md', ...(fix === undefined ? {} : { fix }), docs }], ms()),
  });
  try {
    if (!exists(file)) return { report: unrunReport('agents', 'skipped', 'no AGENTS.md', ms()) };
    const problem = unsafe(root, file);
    if (problem !== undefined) return warn(problem.replace(/ Nothing was written\.$/, ' It was not read.'));
    const result = syncAgents(readFileSync(realpathSync(file), 'utf8'), AGENTS_BLOCK);
    if (!result.ok) return warn(`${result.error.message}`);
    const { change } = result.value;
    if (change === 'unchanged') return { report: reportOf('agents', [], ms()) };
    return warn(
      change === 'appended' ? 'AGENTS.md has no marmeon block — marmeon agents:sync' : "AGENTS.md's marmeon block is out of date — marmeon agents:sync",
      'marmeon agents:sync',
    );
  } catch (error) {
    return warn(`AGENTS.md could not be read: ${plainReason(error, root)}`);
  }
}
