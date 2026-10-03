import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Application, ErrorSolutions, Redactor, Solution } from '@bespokecore/core';
import type { RequestRecording } from './recorder-token.ts';

/** Lines of code shown above and below the line of a frame. */
export const SNIPPET_CONTEXT = 8;
/** Frames that get a code snippet: the app's first ones (or the first frame, when none is the app's). */
const MAX_SNIPPETS = 6;

export interface SnippetLine {
  readonly number: number;
  readonly text: string;
  readonly current: boolean;
}

export interface StackFrame {
  /** The function as the stack names it (`ShowUserController.handle`), if it does. */
  readonly fn: string | undefined;
  /** The absolute path of the file. */
  readonly file: string;
  /** The path as shown: relative to the app's root (`modules/users/controllers/Show.ts`). */
  readonly display: string;
  readonly line: number;
  readonly column: number;
  /** In the app's own code (not a package, not Node's). */
  readonly app: boolean;
  /** `node:internal/…` and the like — no file to show. */
  readonly internal: boolean;
  /** The code around `line`, when the file could be read. */
  readonly snippet?: readonly SnippetLine[];
}

/** A stack's frames — Node's `at fn (file:line:column)` lines; `file://` URLs become paths. */
export function parseStack(stack: string, root: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const match = /^\s*at (?:(.+?) \((.+?):(\d+):(\d+)\)|(.+?):(\d+):(\d+))$/.exec(line);
    if (!match) continue;
    const fn = match[1]?.replace(/^async /, '');
    const location = match[2] ?? match[5]!;
    const file = location.startsWith('file://') ? safePath(location) : location;
    const internal = !isAbsolute(file);
    const inside = !internal && (file === root || file.startsWith(root.endsWith(sep) ? root : root + sep));
    frames.push({
      fn,
      file,
      display: internal ? file : inside ? relative(root, file) : shorten(file, root),
      line: Number(match[3] ?? match[6]),
      column: Number(match[4] ?? match[7]),
      app: inside && !file.includes(`${sep}node_modules${sep}`),
      internal,
    });
  }
  return frames;
}

/** `file` with code snippets for the frames that matter: the app's first ones, or the very first frame. */
export function withSnippets(frames: readonly StackFrame[], context = SNIPPET_CONTEXT): StackFrame[] {
  const sources = new Map<string, string[] | undefined>();
  const lines = (file: string) => {
    if (!sources.has(file)) {
      try {
        sources.set(file, readFileSync(file, 'utf8').split(/\r?\n/));
      } catch {
        sources.set(file, undefined);
      }
    }
    return sources.get(file);
  };
  const wanted = new Set(frames.filter((frame) => frame.app).slice(0, MAX_SNIPPETS));
  const first = frames.find((frame) => !frame.internal);
  if (wanted.size === 0 && first) wanted.add(first);
  return frames.map((frame) => {
    if (!wanted.has(frame)) return frame;
    const source = lines(frame.file);
    if (!source || frame.line < 1 || frame.line > source.length) return frame;
    const from = Math.max(1, frame.line - context);
    const to = Math.min(source.length, frame.line + context);
    const snippet: SnippetLine[] = [];
    for (let number = from; number <= to; number++) snippet.push({ number, text: source[number - 1]!, current: number === frame.line });
    return { ...frame, snippet };
  });
}

/** Where `/__open-in-editor` (Vite's) opens a frame: `file:line:column`. */
export function editorLink(frame: Pick<StackFrame, 'file' | 'line' | 'column'>): string {
  return `/__open-in-editor?file=${encodeURIComponent(`${frame.file}:${frame.line}:${frame.column}`)}`;
}

/** Everything the error page and its Markdown show — **already redacted** (E125): both render only this. */
export interface ErrorReport {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly error: { readonly name: string; readonly message: string };
  /** `cause` after `cause`. */
  readonly causes: readonly { readonly name: string; readonly message: string }[];
  readonly frames: readonly StackFrame[];
  readonly solutions: readonly Solution[];
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly query: unknown;
    readonly body: unknown;
  };
  readonly route:
    | {
        readonly name: string | undefined;
        readonly path: string;
        readonly methods: readonly string[];
        readonly controller: string | undefined;
        readonly middleware: readonly string[];
        readonly params: unknown;
      }
    | undefined;
  readonly queries: readonly { readonly connection: string; readonly sql: string; readonly parameters: readonly unknown[]; readonly durationMs: number; readonly secret: boolean }[];
  readonly droppedQueries: number;
  readonly logs: readonly { readonly level: string; readonly message: string; readonly context: unknown }[];
  readonly droppedLogs: number;
  /** Injection warnings (E128) of the classes built so far. */
  readonly warnings: readonly string[];
  readonly environment: {
    readonly node: string;
    readonly nodeEnv: string | undefined;
    readonly platform: string;
    readonly app: string | undefined;
    readonly packages: readonly { readonly name: string; readonly version: string | undefined }[];
  };
}

export interface ReportInput {
  readonly error: unknown;
  readonly status: number;
  readonly request: Request;
  readonly requestId: string | undefined;
  readonly app: Application;
  readonly redactor: Redactor;
  readonly solutions: ErrorSolutions | undefined;
  readonly route?: {
    readonly name: string | undefined;
    readonly path: string;
    readonly methods: readonly string[];
    readonly controller: string | undefined;
    readonly middleware: readonly string[];
    readonly params: Readonly<Record<string, string>>;
  };
  /** The request's parsed body (the router's `input()`), if it can still be had. */
  readonly body?: () => Promise<unknown>;
  readonly recording?: RequestRecording | undefined;
}

/** Builds the report of an error — every value that leaves the server passes the app's {@link Redactor} (E125). */
export async function buildReport({ error, status, request, requestId, app, redactor, solutions, route, body, recording }: ReportInput): Promise<ErrorReport> {
  const { root } = app;
  const failure = error instanceof Error ? error : new Error(String(error));
  const causes: { name: string; message: string }[] = [];
  for (let cause = failure.cause, depth = 0; cause !== undefined && depth < 5; depth++) {
    causes.push(cause instanceof Error ? { name: cause.name, message: redactor.text(cause.message) } : { name: typeof cause, message: redactor.text(String(cause)) });
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  let parsedBody: unknown = {};
  try {
    parsedBody = body ? await body() : {};
  } catch {
    parsedBody = '[the body could not be read]';
  }
  const url = new URL(request.url);
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0]! : values;
  }
  // Looked up before anything else happens on this request's behalf (a solution may query the database).
  const queries = (recording?.queries ?? []).map((message) => ({
    connection: message.connection,
    ...redactor.query(message),
    durationMs: message.durationMs,
    secret: message.secret,
  }));
  const logs = (recording?.logs ?? []).map((entry) => ({ level: entry.level, message: redactor.text(entry.message), context: redactor.value(entry.context) }));
  const found = (await solutions?.find(error, { app })) ?? [];
  return {
    status,
    requestId,
    error: { name: failure.name, message: redactor.text(failure.message) },
    causes,
    frames: withSnippets(parseStack(failure.stack ?? '', root)).map((frame) => ({ ...frame, ...(frame.fn ? { fn: redactor.text(frame.fn) } : {}) })),
    solutions: found.map((solution) => ({
      title: redactor.text(solution.title),
      text: redactor.text(solution.text),
      ...(solution.command ? { command: redactor.text(solution.command) } : {}),
      ...(solution.docs ? { docs: solution.docs } : {}),
    })),
    request: {
      method: request.method,
      url: redactor.text(url.href),
      headers: redactor.headers(request.headers),
      query: redactor.value(query),
      body: redactor.value(parsedBody),
    },
    route: route && { ...route, params: redactor.value(route.params) },
    queries,
    droppedQueries: recording?.droppedQueries ?? 0,
    logs,
    droppedLogs: recording?.droppedLogs ?? 0,
    warnings: app.container.warnings.map((warning) => warning.message),
    environment: {
      node: process.version,
      nodeEnv: process.env.NODE_ENV,
      platform: `${process.platform} ${process.arch}`,
      app: packageVersion(root)?.name,
      packages: app.packages.map((name) => ({ name, version: packageVersion(join(root, 'node_modules', name))?.version })),
    },
  };
}

function packageVersion(dir: string): { name?: string; version?: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
  } catch {
    return undefined;
  }
}

function safePath(url: string): string {
  try {
    return fileURLToPath(url);
  } catch {
    return url;
  }
}

/** A path outside the app: from `node_modules/…` on, or relative to the app (a workspace package: `../../packages/…`). */
function shorten(file: string, root: string): string {
  const at = file.lastIndexOf(`${sep}node_modules${sep}`);
  return at === -1 ? relative(root, file) : file.slice(at + 1);
}
