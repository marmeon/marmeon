import { REDACTED, Redactor } from '@marmeon/core';
import { runMarmeonJson } from '../spawn.ts';
import { DATA_NOTICE, failure, type ToolDocument, type ToolFailure } from './result.ts';
import type { McpTool, ToolContext } from './tools.ts';

const DEFAULT_LIMIT = 200;
const CHILD_TIMEOUT_MS = 120_000;
const MAX_CHILD_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_WARNING_CHARACTERS = 300;

/** The commands of the app and of the framework with their options, as `marmeon list --json` prints them, filtered by a name prefix and cut. */
export const COMMANDS_TOOL: McpTool = {
  name: 'commands',
  description: `List the commands \`marmeon\` offers in this app, the framework's and the ones its modules add, each with its description, usage line and options (name, type, short form, whether it repeats, default). Narrow by a name prefix such as \`make:\` to find a generator. \`complete: false\` means the app did not load and only the built-in commands are listed. Starts the app once. ${DATA_NOTICE}`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z][a-z0-9:-]{0,99}$', description: 'Only commands whose name starts with this, such as `make:` or `db:`.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: DEFAULT_LIMIT, description: `At most this many commands (default ${DEFAULT_LIMIT}).` },
    },
    additionalProperties: false,
  },
  spawns: true,
  run: commands,
};

interface Option {
  readonly name: string;
  readonly type: string;
  readonly short: string | null;
  readonly multiple: boolean;
  readonly default: string | number | boolean | readonly string[] | readonly boolean[] | null;
}

interface Command {
  readonly name: string;
  readonly description: string;
  readonly usage: string | null;
  readonly options: readonly Option[];
  readonly experimental: boolean;
  readonly launcher: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A default as the command declares it (`parseArgs`: a string, a boolean, or an array of either), masked: it may hold a value from the environment.
 * Under an option whose name looks secret (`password`, `api-key`) the whole value is masked, as the redactor masks a value by its key; booleans are
 * switches, not secrets, and stay.
 */
function copyDefault(name: string, value: unknown, redactor: Redactor): Option['default'] {
  const secret = redactor.isSensitive(name);
  const mask = (text: string) => (secret ? REDACTED : redactor.text(text));
  if (typeof value === 'string') return mask(value);
  if (typeof value === 'number') return secret ? REDACTED : value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.map((item: string) => mask(item));
  if (Array.isArray(value) && value.every((item) => typeof item === 'boolean')) return [...value] as boolean[];
  return null;
}

async function commands(input: Readonly<Record<string, unknown>>, { root, signal }: ToolContext): Promise<ToolDocument | ToolFailure> {
  // The command and its arguments are fixed: nothing of the input reaches the child, the filter applies to its document.
  const run = await runMarmeonJson(root, ['list', '--json'], { timeoutMs: CHILD_TIMEOUT_MS, signal, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES });
  if (run.timedOut) return failure('The app did not answer in time: list was stopped after 120 seconds.');
  if (signal.aborted) return failure('The call was cancelled; marmeon list was stopped.');
  if (run.tooLarge) return failure('list printed more than 16 MiB; the result was dropped.');
  if (run.code !== 0) {
    return failure(`marmeon list failed: ${run.stderrTail.trim() || `it ended with code ${run.code}`}. Run it in a terminal to see the whole message.`);
  }
  if (run.document === undefined) return failure('marmeon list did not print one JSON document: something in the app writes to stdout directly.');
  const document = run.document as Record<string, unknown>;
  const unreadable = () => failure('marmeon list printed a document this version does not read — update marmeon.');
  if (document.format !== 1 || typeof document.complete !== 'boolean' || !Array.isArray(document.commands) || !Array.isArray(document.warnings)) return unreadable();

  const redactor = new Redactor();
  // Fields are copied one by one: a key a later version adds stays behind.
  const all: Command[] = [];
  for (const raw of document.commands as unknown[]) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.description !== 'string' || !Array.isArray(raw.options)) return unreadable();
    const options: Option[] = [];
    for (const option of raw.options as unknown[]) {
      if (!isRecord(option) || typeof option.name !== 'string' || typeof option.type !== 'string') return unreadable();
      options.push({
        name: option.name,
        type: option.type,
        short: typeof option.short === 'string' ? option.short : null,
        multiple: option.multiple === true,
        default: copyDefault(option.name, option.default, redactor),
      });
    }
    all.push({
      name: raw.name,
      description: raw.description,
      usage: typeof raw.usage === 'string' ? raw.usage : null,
      options,
      experimental: raw.experimental === true,
      launcher: raw.launcher === true,
    });
  }

  const prefix = typeof input.name === 'string' ? input.name : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT;
  const matching = prefix === undefined ? all : all.filter((command) => command.name.startsWith(prefix));
  // A warning is the first line of what the app said, masked and cut: it may quote a message of the app's own code.
  const warnings = (document.warnings as unknown[])
    .filter((warning): warning is string => typeof warning === 'string')
    .map((warning) => redactor.text(warning.split('\n')[0]!).slice(0, MAX_WARNING_CHARACTERS));
  return { format: 1, complete: document.complete, commands: matching.slice(0, limit), total: matching.length, truncated: matching.length > limit, warnings };
}
