import { hasPackage } from '../commands/schema-project.ts';
import { runMarmeonJson, type JsonRun } from '../spawn.ts';
import { DATA_NOTICE, failure, type ToolDocument, type ToolFailure } from './result.ts';
import type { McpTool, ToolContext } from './tools.ts';

const CHILD_TIMEOUT_MS = 120_000;
const MAX_CHILD_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_MODULE_NAMES = 20;
const MAX_WARNING_LENGTH = 200;

const UPDATE = 'this version does not read — update marmeon.';

/** What the app defines — modules, providers, events and their listeners, jobs, commands, schedules, packages — as `marmeon modules:list --json` and `schedule:list --json` print it, copied field by field. */
export const APP_OVERVIEW_TOOL: McpTool = {
  name: 'app_overview',
  description: `Give an overview of the app: its packages, the providers of the app and of each module, the commands, jobs, notifications, seeders and migration folder of each module, each event with its listeners, and the scheduled tasks (name, expression, time zone). Use it to find what exists before placing code. Listeners that a provider adds in boot() are missing. Starts the app once, twice when it has a scheduler. ${DATA_NOTICE}`,
  inputSchema: {
    type: 'object',
    properties: {
      module: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\r\\n-][^\\r\\n]{0,199}$', description: 'Only this module, with the listeners it declares; not the app\'s or providers\'.' },
    },
    additionalProperties: false,
  },
  spawns: true,
  run: appOverview,
};

/** A document that is not what this version reads. */
class Unreadable extends Error {}

type Fields = Record<string, unknown>;

function record(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Unreadable();
  return value as Fields;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Unreadable();
  return value;
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Unreadable();
  return value;
}

function nullable(value: unknown): string | null {
  return value === null ? null : string(value);
}

function strings(value: unknown): string[] {
  return list(value).map(string);
}

interface Listener { listener: string; queued: boolean; defined: 'app' | 'module' | 'provider'; module: string | null }
interface Event { event: string; name: string | null; listeners: Listener[] }
interface Module {
  name: string;
  providers: string[];
  commands: string[];
  jobs: { class: string; job: string | null }[];
  notifications: { class: string; notification: string | null }[];
  seeders: string[];
  migrations: string | null;
}

function listener(value: unknown): Listener {
  const raw = record(value);
  if (typeof raw.queued !== 'boolean' || (raw.defined !== 'app' && raw.defined !== 'module' && raw.defined !== 'provider')) throw new Unreadable();
  return { listener: string(raw.listener), queued: raw.queued, defined: raw.defined, module: nullable(raw.module) };
}

function event(value: unknown): Event {
  const raw = record(value);
  return { event: string(raw.event), name: nullable(raw.name), listeners: list(raw.listeners).map(listener) };
}

function module(value: unknown): Module {
  const raw = record(value);
  return {
    name: string(raw.name),
    providers: strings(raw.providers),
    commands: strings(raw.commands),
    jobs: list(raw.jobs).map((item) => ({ class: string(record(item).class), job: nullable(record(item).job) })),
    notifications: list(raw.notifications).map((item) => ({ class: string(record(item).class), notification: nullable(record(item).notification) })),
    seeders: strings(raw.seeders),
    migrations: nullable(raw.migrations),
  };
}

function task(value: unknown): { name: string; expression: string; timeZone: string; description: string | null } {
  const raw = record(value);
  return { name: string(raw.name), expression: string(raw.expression), timeZone: string(raw.timeZone), description: nullable(raw.description) };
}

/** Why a command that did not give a document cannot be used, as one sentence from the first line of the end of its stderr. */
function firstLine(run: JsonRun): string {
  return run.stderrTail.trim().split('\n')[0]!.trim().slice(0, MAX_WARNING_LENGTH);
}

/** The stop that every call shares: out of time, cancelled, too much output. */
function stopped(run: JsonRun, command: string, signal: AbortSignal): ToolFailure | undefined {
  if (run.timedOut) return failure(`The app did not answer in time: ${command} was stopped after 120 seconds.`);
  if (signal.aborted) return failure(`The call was cancelled; marmeon ${command} was stopped.`);
  if (run.tooLarge) return failure(`${command} printed more than 16 MiB; the result was dropped.`);
  return undefined;
}

async function appOverview(input: Readonly<Record<string, unknown>>, { root, signal }: ToolContext): Promise<ToolDocument | ToolFailure> {
  const only = typeof input.module === 'string' ? input.module : undefined;
  // The commands and their arguments are fixed: nothing of the input reaches a child, the filter applies to the document.
  const run = await runMarmeonJson(root, ['modules:list', '--json'], { timeoutMs: CHILD_TIMEOUT_MS, signal, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES });
  const halted = stopped(run, 'modules:list', signal);
  if (halted) return halted;
  if (run.code !== 0) {
    return failure(`marmeon modules:list failed: ${run.stderrTail.trim() || `it ended with code ${run.code}`}. Run it in a terminal to see the whole message.`);
  }
  if (run.document === undefined) return failure('marmeon modules:list did not print one JSON document: something in the app writes to stdout directly.');

  let packages: string[];
  let app: { providers: string[] };
  let modules: Module[];
  let events: Event[];
  const warnings: string[] = [];
  try {
    const document = record(run.document);
    if (document.format !== 1) throw new Unreadable();
    // Each part is rebuilt from known fields; nothing else of the document is passed on.
    packages = strings(document.packages);
    app = { providers: strings(record(document.app).providers) };
    modules = list(document.modules).map(module);
    events = list(document.events).map(event);
    warnings.push(...list(document.warnings).filter((warning): warning is string => typeof warning === 'string'));
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return failure(`marmeon modules:list printed a document ${UPDATE}`);
  }

  if (only !== undefined) {
    if (!modules.some((item) => item.name === only)) {
      const names = modules.slice(0, MAX_MODULE_NAMES).map((item) => item.name);
      return failure(`No module named ${only}. Modules: ${names.length > 0 ? names.join(', ') : '(none)'}${modules.length > MAX_MODULE_NAMES ? ', …' : ''}.`);
    }
    modules = modules.filter((item) => item.name === only);
    events = events
      .map((item) => ({ ...item, listeners: item.listeners.filter((entry) => entry.defined === 'module' && entry.module === only) }))
      .filter((item) => item.listeners.length > 0);
  }

  let schedules: { name: string; expression: string; timeZone: string; description: string | null }[] | null = null;
  if (only === undefined) {
    if (!hasPackage(root, '@marmeon/scheduler')) schedules = [];
    else {
      // A schedule that cannot be read leaves the rest of the overview intact: it is a warning, not an error.
      const second = await runMarmeonJson(root, ['schedule:list', '--json'], { timeoutMs: CHILD_TIMEOUT_MS, signal, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES });
      if (signal.aborted) return failure('The call was cancelled; marmeon schedule:list was stopped.');
      if (second.timedOut || second.tooLarge || second.code !== 0 || second.document === undefined) {
        const why = second.timedOut ? 'it ran out of time' : second.tooLarge ? 'it printed too much' : second.code !== 0 ? firstLine(second) || `it ended with code ${second.code}` : 'it did not print one JSON document';
        warnings.push(`The schedules are missing: marmeon schedule:list failed: ${why}`.slice(0, MAX_WARNING_LENGTH));
      } else {
        try {
          const document = record(second.document);
          if (document.format !== 2) throw new Unreadable();
          schedules = list(document.tasks).map(task);
        } catch (error) {
          if (!(error instanceof Unreadable)) throw error;
          warnings.push(`The schedules are missing: marmeon schedule:list printed a document ${UPDATE}`);
        }
      }
    }
  }

  return { format: 1, packages, app, modules, events, schedules, warnings };
}
