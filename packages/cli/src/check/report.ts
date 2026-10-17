import type { ErrorCode } from '@marmeon/core';

/** One finding of a check. Fields a tool cannot tell are left out. */
export interface CheckProblem {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** Relative to the app root, `/`-separated. */
  readonly file?: string;
  /** 1-based. */
  readonly line?: number;
  /** 1-based. */
  readonly column?: number;
  /** A Marmeon error code (docs/errors.md#server-error-codes). */
  readonly code?: ErrorCode;
  /** The tool's name for it: `TS2322`, `eslint(no-debugger)`, `marmeon(no-internal-imports)`. */
  readonly rule?: string;
  /** A command to run — shown, never run. */
  readonly fix?: string;
  readonly docs?: string;
}

/** `passed`, `warning` (findings of the level warning only) and `failed` follow from the findings; `skipped` and `error` (the check could not run) are set by the run, with a `reason`. */
export type CheckStatus = 'passed' | 'warning' | 'failed' | 'skipped' | 'error';

/** The result of one check. See docs/check.md#status. */
export interface CheckReport {
  readonly name: string;
  readonly status: CheckStatus;
  /** Milliseconds the check took. */
  readonly ms: number;
  readonly reason?: string;
  readonly problems: readonly CheckProblem[];
}

/** The report of a check that ran: its status is the worst of `problems`. */
export function reportOf(name: string, problems: readonly CheckProblem[], ms: number): CheckReport {
  const status = problems.some((problem) => problem.severity === 'error') ? 'failed' : problems.length > 0 ? 'warning' : 'passed';
  return { name, status, ms, problems };
}

/** The report of a check that was left out (`skipped`) or could not run (`error`). */
export function unrunReport(name: string, status: 'skipped' | 'error', reason: string, ms: number): CheckReport {
  return { name, status, ms, reason, problems: [] };
}

/** The exit code of `marmeon check`: 1 when any check found an error, else 3 when one could not run, else 0. */
export function exitCodeOf(reports: readonly CheckReport[]): 0 | 1 | 3 {
  if (reports.some((report) => report.status === 'failed')) return 1;
  return reports.some((report) => report.status === 'error') ? 3 : 0;
}

/** `text` with control characters (a file name can hold them, and a terminal obeys them) written as `\xNN`; line feeds and tabs stay when `keepWhitespace` (a carriage return can overwrite the line before it, so it never does). */
export function escapeControl(text: string, keepWhitespace = false): string {
  let escaped = '';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    escaped += control && !(keepWhitespace && (code === 9 || code === 10)) ? `\\x${code.toString(16).padStart(2, '0')}` : character;
  }
  return escaped;
}

/** The JSON form of a problem: every key present, `null` for what the tool does not know. */
export function problemJson(problem: CheckProblem) {
  return {
    severity: problem.severity,
    message: problem.message,
    file: problem.file ?? null,
    line: problem.line ?? null,
    column: problem.column ?? null,
    code: problem.code ?? null,
    rule: problem.rule ?? null,
    fix: problem.fix ?? null,
    docs: problem.docs ?? null,
  };
}

/** The JSON form of a report: every key present, `reason` is `null` when the check ran. */
export function reportJson(report: CheckReport) {
  return { name: report.name, status: report.status, ms: report.ms, reason: report.reason ?? null, problems: report.problems.map(problemJson) };
}
