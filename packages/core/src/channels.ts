/**
 * The framework's observation points: TracingChannels `tracing:marmeon:<operation>:…` and the plain channels `marmeon:log`,
 * `marmeon:exception` and `marmeon:event` (docs/observability.md#the-channels). Every message names its app; nothing is built
 * without a subscriber; values are raw — whatever records or shows them redacts them first.
 */
import { channel as plainChannel, tracingChannel, type TracingChannel } from 'node:diagnostics_channel';
import type { Application } from './application.ts';
import { currentJob, currentRequest, currentTask } from './request-context.ts';

/**
 * What every message carries.
 */
export interface MessageBase {
  /** The application the message is about — `channels.subscribe(app, …)` passes on only its own. */
  readonly app: Application;
  /** When it started (epoch ms, sub-millisecond: `performance.timeOrigin + performance.now()`). */
  readonly startedAt: number;
  /** The request it happened in (its `x-request-id`), if any. */
  readonly requestId?: string;
  /** The queued job it happened in (the job's id, stable over retries), if any. */
  readonly jobId?: string;
  /** The scheduled task it happened in, if any. */
  readonly task?: string;
}

/**
 * What a traced operation knows once it ended — set before the `end` (and `error`) handlers run.
 */
export interface Ended {
  /** How long it took (ms). */
  durationMs?: number;
  /** Why it failed (set by Node's TracingChannel before `error`). */
  error?: unknown;
}

/**
 * `tracing:marmeon:http.request` — one request through the kernel, from the request id to the response's headers.
 */
export interface HttpRequestMessage extends MessageBase, Ended {
  readonly requestId: string;
  readonly method: string;
  /** The path as requested (no query string). */
  readonly path: string;
  /** The URL as requested, with its query string — raw: redact before recording or showing. */
  readonly url: string;
  /** The request's headers — raw (cookies, `authorization`): redact before recording or showing. */
  readonly headers: Headers;
  /** `island` or `layer`: a region's request (`x-marmeon-region`). */
  readonly region?: string;
  /** Resolved in-process for another request — an island while its page renders, a layer's base for its deep link. */
  readonly inProcess: boolean;
  /** The matched route's name (`users.show`) — unnamed routes and unknown paths have none. */
  route?: string;
  /** The matched route's pattern (`/users/:user`) — OpenTelemetry's `http.route`. */
  routePath?: string;
  /** The action's class name (`ShowUserController`); none for a closure. */
  controller?: string;
  /** The response's status. */
  status?: number;
  /**
   * Where the response sends the browser — a redirect's `Location`, or with a 409 the protocol's `x-marmeon-location` (a full
   * reload: a new build, or crossing the sign-in boundary) — raw: redact before recording.
   */
  location?: string;
  /** With a 409 and a location: why the browser reloads (`x-marmeon-reload`: `version`, `history`). */
  reload?: string;
  /** The page or island it answered with — set only while something listens (the devtools). */
  page?: PageSummary;
  /** The body, as the app read it (never read for this — unset when nothing read it) — raw: redact before recording. */
  input?: Readonly<Record<string, unknown>>;
}

/**
 * What a request answered with when it was a page (a view, a layer) or an island: its view, and how big each prop was.
 */
export interface PageSummary {
  /** The view (`users/Show`). */
  readonly component: string;
  /** Each prop sent and the bytes of its JSON — the shared ones included. */
  readonly props: Readonly<Record<string, number>>;
  /** A partial reload's props (`only`), if it named them. */
  readonly only?: readonly string[];
  /** A partial reload's left-out props (`except`). */
  readonly except?: readonly string[];
  /** The props deferred to later requests, by group. */
  readonly deferred?: Readonly<Record<string, readonly string[]>>;
  /** Sent props that are shared (`SharedData`), not the controller's own. */
  readonly shared?: readonly string[];
  /** `optional()` props left out — sent only when a partial reload names them. */
  readonly optional?: readonly string[];
  /** `page`, `layer` or `island`. */
  readonly kind: 'page' | 'layer' | 'island';
}

/**
 * `tracing:marmeon:db.query` — one statement, published once it finished (Kysely reports queries afterwards).
 */
export interface DbQueryMessage extends MessageBase, Ended {
  /** The connection's name (`default`). */
  readonly connection: string;
  /** The connection's driver: `sqlite` or `pgsql`. */
  readonly driver: string;
  readonly sql: string;
  /** As bound — raw. Redact before recording or showing; with `secret`, all of them. */
  readonly parameters: readonly unknown[];
  /** The statement touches a table with secret columns (`.secret()` in its migration) — its parameters may hold secrets. */
  readonly secret: boolean;
  durationMs: number;
}

/**
 * `tracing:marmeon:queue.dispatch` — one `dispatch()`, `bulk()` or `chain()` of the `Queue`.
 */
export interface QueueDispatchMessage extends MessageBase, Ended {
  readonly kind: 'dispatch' | 'bulk' | 'chain';
  /** The jobs' names (`static job`), in order. */
  readonly jobs: readonly string[];
  readonly connection: string;
  readonly queue: string;
  /** Seconds before they may run. */
  readonly delay: number;
  /** A unique dispatch's key. */
  readonly unique?: string;
  /** Their ids, once queued — none when a unique job with the key was queued already. */
  jobIds: string[];
  /** Their payloads as given, in order — raw: shown only through the redactor, an encrypted one never. */
  readonly payloads?: readonly unknown[];
  /** Which of them are encrypted (`static encrypted`), in order. */
  readonly encrypted?: readonly boolean[];
  /**
   * The trace context to carry to the worker (W3C `traceparent`) — set by a tracer in its `start` handler
   * (`@marmeon/otel`); stored with each job and passed on in its `queue.job` message.
   */
  traceparent?: string;
}

/**
 * `tracing:marmeon:queue.job` — one attempt of a job (in a worker, the `sync` connection, or a test's `app.queue.work()`).
 */
export interface QueueJobMessage extends MessageBase, Ended {
  readonly job: string;
  /** This job's id. */
  readonly jobId: string;
  readonly queue: string;
  readonly connection: string;
  /** From 1. */
  readonly attempt: number;
  /** The request that dispatched it, if one did. */
  readonly originRequestId?: string;
  /** The trace context it was dispatched in, if a tracer gave one. */
  readonly traceparent?: string;
  /** Its payload, as the job gets it — raw: shown only through the redactor, an encrypted one never. */
  readonly payload?: unknown;
  /** The job is encrypted (`static encrypted`): its payload is never shown. */
  readonly encrypted?: boolean;
  /** What the job asked for: `done`, or `discarded`/`released`/`failed` through its context; unset when it threw. */
  outcome?: 'done' | 'discarded' | 'released' | 'failed';
}

/**
 * `tracing:marmeon:schedule.task` — one run of a scheduled task.
 */
export interface ScheduleTaskMessage extends MessageBase, Ended {
  readonly task: string;
  /** The minute it was due (epoch ms). */
  readonly minute: number;
  readonly reason: 'due' | 'catch-up' | 'test';
  outcome?: 'ran' | 'skipped' | 'failed';
  /** Why it was skipped: `filter`, `other-server`, `overlapping`, `job-waiting`. */
  skipped?: string;
}

/**
 * `tracing:marmeon:mail.send` — a mail sent now, queued (composed now, sent by a worker), or sent by that worker.
 */
export interface MailSendMessage extends MessageBase, Ended {
  /** The mailable's class name. */
  readonly mailable: string;
  /** `send`: `mailer.send()`; `queue`: `mailer.queue()`; `worker`: the queued mail handed to the transport. */
  readonly mode: 'send' | 'queue' | 'worker';
  /** The recipients' addresses, once composed. */
  to?: string[];
  subject?: string;
  /** The sender, copies and body, once composed — raw: links in them may carry tokens (redact before recording). */
  from?: string;
  cc?: string[];
  bcc?: string[];
  html?: string;
  text?: string;
  /** Attachments by name and size only. */
  attachments?: { readonly filename: string; readonly bytes: number; readonly contentType?: string }[];
}

/**
 * `tracing:marmeon:notification.send` — one notification for one recipient: queued (`send`) or delivered (`sendNow`, the worker).
 */
export interface NotificationSendMessage extends MessageBase, Ended {
  /** `static notification`. */
  readonly notification: string;
  /** The notification's id. */
  readonly id: string;
  readonly recipient: { readonly type: string; readonly id: string | number };
  readonly queued: boolean;
  /** The channels `via()` chose (deliveries only). */
  channels?: string[];
  outcome?: 'delivered' | 'gone' | 'delivered-before';
}

/**
 * `tracing:marmeon:live.refresh` — a live hint going out (after its commit).
 */
export interface LiveRefreshMessage extends MessageBase, Ended {
  readonly channel: string;
  /** The props it names; `null`: every prop each follower follows. */
  readonly only: readonly string[] | null;
}

/**
 * `tracing:marmeon:render.ssr` — server rendering of a page, until its shell (or, for a bot, the whole page) is ready.
 */
export interface SsrRenderMessage extends MessageBase, Ended {
  /** The page's view. */
  readonly component: string;
  /** Rendered completely before sending (crawlers), not streamed. */
  readonly complete: boolean;
  /** The document is streamed on (Suspense boundaries after the shell). */
  streamed?: boolean;
}

/**
 * `tracing:marmeon:command.run` — one `marmeon <command>` run in its own process (not a scheduled one: that is a task).
 */
export interface CommandRunMessage extends MessageBase, Ended {
  /** Its name: `migrate`, `db:seed`. */
  readonly command: string;
  /** Its arguments as given — raw (`--password=…`): redact before recording. */
  readonly args: readonly string[];
  /** What it exited with. */
  exitCode?: number;
}

/**
 * `marmeon:event` — an app event dispatched through the `EventDispatcher` (also one a test's `EventFake` holds back).
 */
export interface EventDispatchMessage extends MessageBase {
  /** The event object — raw: redact before recording. */
  readonly event: object;
  /** Its `static event` name, else its class name. */
  readonly name: string;
  /** The listeners registered for it, by name (a queued one is queued, not run here). */
  readonly listeners: readonly string[];
}

/**
 * `marmeon:log` — a log entry as written, at any level (the logger's level does not filter it).
 */
export interface LogMessage extends MessageBase {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  /** The logger's bindings (`{ channel: 'http' }`) and the entry's own context — raw. */
  readonly context: Readonly<Record<string, unknown>>;
}

/**
 * `marmeon:exception` — an error a request ended in, on its way to the `ExceptionHandler`.
 */
export interface ExceptionMessage extends MessageBase {
  readonly error: unknown;
  /** What the client gets: an `HttpError`'s status, 422 for invalid input, else 500. */
  readonly status: number;
  readonly method: string;
  readonly path: string;
  /** The matched route's pattern (`/invite/:code`); none for an unknown path. Lets a subscriber mask the route's sensitive parameters in `path`. */
  readonly routePath?: string;
  /** The request's `Sec-Fetch-Site` (`same-origin`, `cross-site`, …), when the browser sent it. */
  readonly fetchSite?: string;
}

/**
 * The traced operations and their messages. Packages may add their own through declaration merging.
 */
export interface TracingMessages {
  'http.request': HttpRequestMessage;
  'db.query': DbQueryMessage;
  'queue.dispatch': QueueDispatchMessage;
  'queue.job': QueueJobMessage;
  'schedule.task': ScheduleTaskMessage;
  'mail.send': MailSendMessage;
  'notification.send': NotificationSendMessage;
  'live.refresh': LiveRefreshMessage;
  'render.ssr': SsrRenderMessage;
  'command.run': CommandRunMessage;
}

/**
 * The plain channels (one message, nothing traced) and their messages.
 */
export interface EventMessages {
  log: LogMessage;
  exception: ExceptionMessage;
  event: EventDispatchMessage;
}

export type TracingName = keyof TracingMessages & string;
export type EventName = keyof EventMessages & string;
export type ChannelName = TracingName | EventName;
/**
 * The message of a channel: `ChannelMessage<'db.query'>`.
 */
export type ChannelMessage<N extends ChannelName> = N extends TracingName ? TracingMessages[N] : N extends EventName ? EventMessages[N] : never;

/** What a subscriber of a traced operation hears. */
export interface TracingHandlers<M> {
  /** Before the operation (for `db.query`: once it finished — Kysely reports queries afterwards). */
  start?(message: M): void;
  /** After it — succeeded, or failed with `message.error` — with `durationMs`. */
  end?(message: M): void;
  /** It failed (before `end`). */
  error?(message: M & { error: unknown }): void;
}

/**
 * Runs a traced operation's work in a context of the subscriber's — a tracer's active span — for {@link channels.around}.
 * Call `run` once and synchronously (`context.with(ctx, run)`); what it returns is the operation's, not the wrapper's.
 */
export type Around<M> = (message: M, run: () => unknown) => void;

/** A plain channel, typed: what framework packages publish through. */
export interface EventChannel<M> {
  readonly hasSubscribers: boolean;
  publish(message: M): void;
}

const TRACING: readonly TracingName[] = [
  'http.request',
  'db.query',
  'queue.dispatch',
  'queue.job',
  'schedule.task',
  'mail.send',
  'notification.send',
  'live.refresh',
  'render.ssr',
  'command.run',
];
const EVENTS: readonly EventName[] = ['log', 'exception', 'event'];

// Node's channels are process-wide by name; these are handles to them, created once (Node recommends top-level handles).
const tracings = new Map<string, TracingChannel<object>>(TRACING.map((name) => [name, tracingChannel<object>(`marmeon:${name}`)]));
const events = new Map<string, EventChannel<object>>(EVENTS.map((name) => [name, plainChannel(`marmeon:${name}`) as EventChannel<object>]));

/** Messages built for an app — tests prove that nothing is built without a subscriber. Kept on the app itself. */
const BUILT: unique symbol = Symbol.for('marmeon.diagnostics.built');

/** The wrappers of each traced channel ({@link channels.around}), per app — consulted only while the channel has subscribers. */
const arounds = new Map<object, Set<{ readonly app: Application; readonly around: Around<object> }>>();

/** A subscriber's error never reaches the operation it watches (Node would rethrow it as an uncaught exception). */
function guarded<M>(name: string, handler: ((message: M) => void) | undefined, app: Application): ((message: M) => void) | undefined {
  if (!handler) return undefined;
  return (message) => {
    if ((message as { app?: unknown }).app !== app) return;
    try {
      handler(message);
    } catch (error) {
      process.emitWarning(`A subscriber of marmeon:${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`, 'MarmeonDiagnosticsWarning');
    }
  };
}

/**
 * What `channels.subscribe` takes for a channel: `{ start?, end?, error? }` for a traced one, one function for a plain one.
 */
export type ChannelHandlers<N extends ChannelName> = N extends TracingName ? TracingHandlers<TracingMessages[N]> : (message: ChannelMessage<N>) => void;

function subscribe<N extends ChannelName>(app: Application, name: N, handlers: ChannelHandlers<N>): () => void;
function subscribe(app: Application, name: ChannelName, handlers: TracingHandlers<object> | ((message: object) => void)): () => void {
  const tracing = tracings.get(name);
  if (tracing) {
    if (typeof handlers !== 'object' || handlers === null) throw new TypeError(`channels.subscribe(app, '${name}', handlers): give { start?, end?, error? }.`);
    const subscribers: Partial<Record<'start' | 'asyncEnd' | 'error', (message: object) => void>> = {};
    const start = guarded(name, handlers.start?.bind(handlers), app);
    const end = guarded(name, handlers.end?.bind(handlers), app);
    const error = guarded(name, handlers.error?.bind(handlers) as ((message: object) => void) | undefined, app);
    if (start) subscribers.start = start;
    if (end) subscribers.asyncEnd = end;
    if (error) subscribers.error = error;
    tracing.subscribe(subscribers);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      tracing.unsubscribe(subscribers);
    };
  }
  const event = events.get(name);
  if (!event) throw new TypeError(`There is no channel "${name}". Channels: ${[...TRACING, ...EVENTS].join(', ')}.`);
  if (typeof handlers !== 'function') throw new TypeError(`channels.subscribe(app, '${name}', handler): give a function — ${name} is a plain channel.`);
  const handler = guarded(name, handlers, app)!;
  const named = plainChannel(`marmeon:${name}`);
  named.subscribe(handler as (message: unknown) => void);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    named.unsubscribe(handler as (message: unknown) => void);
  };
}

/** The framework's channels. */
export const channels = {
  /**
   * Listens to one channel, for one app's messages only. Returns `off` — call it when the subscriber stops (a provider's
   * `shutdown()`). A handler that throws is reported as a process warning; the operation goes on.
   *
   * ```ts
   * channels.subscribe(app, 'http.request', { end: (request) => … });   // traced: start / end / error
   * channels.subscribe(app, 'log', (entry) => …);                       // plain: one handler
   * ```
   */
  subscribe,

  /**
   * Runs the work of each traced operation of `app` on channel `name` inside `around` — so what the operation does (its
   * queries, jobs, log lines) runs in a context of the subscriber's (`@marmeon/otel`: the operation's span). A `start` handler
   * cannot do that, and Node's `bindStore` cannot carry OpenTelemetry's context: Node 26 enters a bound store with
   * `store.withScope()`, which only an `AsyncLocalStorage` has. `run` must be called once, synchronously; a wrapper that throws
   * or never calls it is a process warning and the work runs without it. Not for `db.query`. Returns `off`.
   */
  around<N extends TracingName>(app: Application, name: N, around: Around<TracingMessages[N]>): () => void {
    const tracing = tracings.get(name);
    if (!tracing) throw new TypeError(`There is no traced channel "${name}". Traced: ${TRACING.join(', ')}.`);
    let set = arounds.get(tracing);
    if (!set) arounds.set(tracing, (set = new Set()));
    const entry = { app, around: around as Around<object> };
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  },

  /**
   * The TracingChannel of a traced operation — where framework packages publish (`if (channel.hasSubscribers) …`), and
   * what a tracer binds its context store to (`channel.start.bindStore(…)`). A raw subscriber gets every app's messages:
   * compare `message.app` itself.
   */
  tracing<N extends TracingName>(name: N): TracingChannel<TracingMessages[N]> {
    const tracing = tracings.get(name);
    if (!tracing) throw new TypeError(`There is no traced channel "${name}". Traced: ${TRACING.join(', ')}.`);
    return tracing as unknown as TracingChannel<TracingMessages[N]>;
  },

  /** A plain channel (`log`, `exception`), typed. */
  event<N extends EventName>(name: N): EventChannel<EventMessages[N]> {
    const event = events.get(name);
    if (!event) throw new TypeError(`There is no plain channel "${name}". Plain: ${EVENTS.join(', ')}.`);
    return event as EventChannel<EventMessages[N]>;
  },

  /** How many messages were built for `app` so far — 0 while nobody subscribes. */
  built(app: Application): number {
    return (app as unknown as { [BUILT]?: number })[BUILT] ?? 0;
  },
};

/**
 * The fields every message starts with — `app`, `startedAt` and where it happens (request, job, task). Call it only
 * behind a `hasSubscribers` check: it counts as a message built.
 */
export function messageBase(app: Application): MessageBase {
  const counted = app as unknown as { [BUILT]?: number };
  counted[BUILT] = (counted[BUILT] ?? 0) + 1;
  const request = currentRequest();
  const job = currentJob();
  const task = currentTask();
  return {
    app,
    startedAt: performance.timeOrigin + performance.now(),
    ...(request ? { requestId: request.requestId } : {}),
    ...(job ? { jobId: job.jobId } : {}),
    ...(task ? { task: task.task } : {}),
  };
}

/**
 * Runs `fn` traced on `channel`: start → end → (error) → asyncStart → asyncEnd, with `durationMs` set before the
 * operation counts as ended, and `fn` inside the start channel's bound stores (a tracer's context). `finish` fills in what
 * the result says (a status, an outcome) before the `end` handlers run.
 */
export function trace<M extends MessageBase & Ended, T>(channel: TracingChannel<M>, message: M, fn: () => Promise<T>, finish?: (message: M, result: T) => void): Promise<T> {
  const started = performance.now();
  return channel.tracePromise(async () => {
    try {
      const result = await within(channel, message, fn);
      finish?.(message, result);
      return result;
    } finally {
      message.durationMs = performance.now() - started;
    }
  }, message);
}

function nameOf(channel: object): string | undefined {
  for (const [name, tracing] of tracings) if (tracing === channel) return name;
  return undefined;
}

/** `fn`, inside the wrappers of `message.app` on `channel` ({@link channels.around}), in the order they were added. */
function within<M extends MessageBase, T>(channel: TracingChannel<M>, message: M, fn: () => Promise<T>): Promise<T> {
  const set = arounds.get(channel);
  if (!set || set.size === 0) return fn();
  let run = fn;
  for (const { app, around } of set) {
    if (app !== message.app) continue;
    const inner = run;
    run = () => {
      // The operation runs once: inside the wrapper if it calls `run`, else (it threw first, or forgot) without it.
      let called = false;
      let started: Promise<T> | undefined;
      try {
        around(message, () => {
          if (!called) {
            called = true;
            started = inner();
          }
          return started;
        });
      } catch (error) {
        if (called && started === undefined) throw error; // the operation itself threw, synchronously
        process.emitWarning(`A wrapper of marmeon:${String(nameOf(channel))} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`, 'MarmeonDiagnosticsWarning');
      }
      if (!called) {
        process.emitWarning(`A wrapper of marmeon:${String(nameOf(channel))} did not run the operation; it ran without it.`, 'MarmeonDiagnosticsWarning');
        return inner();
      }
      return started!;
    };
  }
  return run();
}

/**
 * Publishes an operation that already ended (a query: Kysely reports it afterwards) as a traced one would have been:
 * start → end → (error) → asyncStart → asyncEnd.
 */
export function publishEnded<M extends MessageBase & Ended>(channel: TracingChannel<M>, message: M): void {
  channel.start.publish(message);
  channel.end.publish(message);
  if (message.error !== undefined) channel.error.publish(message);
  channel.asyncStart.publish(message);
  channel.asyncEnd.publish(message);
}
