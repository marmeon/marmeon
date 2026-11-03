import { BUILT_IN_CHECKS } from '../check/registry.ts';
import { runMarmeonJson } from '../spawn.ts';
import { DATA_NOTICE, failure, type ToolDocument, type ToolFailure } from './result.ts';
import type { McpTool, ToolContext } from './tools.ts';

const DEFAULT_MAX_PROBLEMS = 100;
const CHECK_TIMEOUT_MS = 10 * 60_000;
const MAX_CHILD_STDOUT_BYTES = 16 * 1024 * 1024;

/** The names of checks: kebab-case, the shape `static check` of a check has. Starts with a letter, so no value is ever an option. */
const NAME = '^[a-z][a-z0-9-]{0,63}$';

const names = (description: string) => ({ type: 'array', items: { type: 'string', pattern: NAME, maxLength: 64 }, minItems: 1, maxItems: 20, uniqueItems: true, description });

interface Problem {
  readonly [key: string]: unknown;
}

interface CheckEntry {
  readonly [key: string]: unknown;
  readonly problems?: unknown;
  readonly silenced?: unknown;
}

/**
 * `marmeon check --json` with a time limit. `timeoutMs` is a parameter for tests: the tool offers no way to change it. A second call
 * while one runs is refused before it waits in the queue.
 */
export function checkTool({ timeoutMs = CHECK_TIMEOUT_MS }: { readonly timeoutMs?: number } = {}): McpTool {
  let running = false;
  return {
    name: 'check',
    description: `Run marmeon check and return its report: ${BUILT_IN_CHECKS.join(', ')}, and the checks the app's packages add. It starts the app once and runs tsc, so it can take minutes; for a quick round use only: ['types', 'lint']. Every check has its status and its problems (file, line, rule, fix). ${DATA_NOTICE}`,
    inputSchema: {
      type: 'object',
      properties: {
        only: names('Run only these checks.'),
        skip: names('Leave these checks out.'),
        maxProblems: { type: 'integer', minimum: 1, maximum: 1000, default: DEFAULT_MAX_PROBLEMS, description: `Keep at most this many problems per check (default ${DEFAULT_MAX_PROBLEMS}).` },
      },
      additionalProperties: false,
    },
    spawns: true,
    admit() {
      if (running) return failure('A check is running; wait for its result.');
      running = true;
      return undefined;
    },
    async run(input, context) {
      try {
        return await runCheck(input, context, timeoutMs);
      } finally {
        running = false;
      }
    },
  };
}

export const CHECK_TOOL: McpTool = checkTool();

async function runCheck(input: Readonly<Record<string, unknown>>, { root, signal }: ToolContext, timeoutMs: number): Promise<ToolDocument | ToolFailure> {
  const only = stringList(input.only);
  const skip = stringList(input.skip);
  const maxProblems = typeof input.maxProblems === 'number' ? input.maxProblems : DEFAULT_MAX_PROBLEMS;
  // One token per option, from values the schema checked; the command is fixed.
  const args = ['check', '--json', ...(only ? [`--only=${only.join(',')}`] : []), ...(skip ? [`--skip=${skip.join(',')}`] : [])];
  // Exit 1 (a check failed) and 3 (a check could not run) print the report like 0.
  const run = await runMarmeonJson(root, args, { timeoutMs, signal, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES, documentCodes: [0, 1, 3] });
  if (run.timedOut) return failure('marmeon check did not finish within 10 minutes; run it in a terminal, or narrow it with only.');
  if (signal.aborted) return failure('The call was cancelled; marmeon check was stopped.');
  if (run.tooLarge) return failure('marmeon check printed more than 16 MiB; the result was dropped. Narrow it with only.');
  if (run.code === 2) return failure(`marmeon check was called wrongly: ${run.stderrTail.trim() || 'no message'}`);
  if (run.code !== 0 && run.code !== 1 && run.code !== 3) return failure(`marmeon check ended with code ${run.code}: ${run.stderrTail.trim() || 'no message'}`);
  if (run.document === undefined) return failure('marmeon check did not print one JSON document: something in the app writes to stdout directly.');
  const report = run.document as { format?: unknown; checks?: unknown };
  if (report.format !== 1 || !Array.isArray(report.checks)) return failure('marmeon check printed a document this version does not read — update marmeon.');
  const [cut, truncated] = cutProblems(report as { checks: CheckEntry[] }, maxProblems);
  return {
    format: 1,
    exitCode: run.code,
    report: cut,
    truncated,
    warnings: truncated ? [`The problems of a check were cut to ${maxProblems}; raise maxProblems or narrow the run with only.`] : [],
  };
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

/** `report` with at most `max` problems (and silenced problems) in each check, and whether any check was cut. */
function cutProblems(report: { checks: CheckEntry[] }, max: number): [unknown, boolean] {
  let truncated = false;
  const checks = report.checks.map((entry) => {
    const cut: Record<string, unknown> = { ...entry };
    for (const key of ['problems', 'silenced'] as const) {
      const list = entry[key];
      if (Array.isArray(list) && list.length > max) {
        cut[key] = (list as Problem[]).slice(0, max);
        truncated = true;
      }
    }
    return cut;
  });
  return [{ ...report, checks }, truncated];
}
