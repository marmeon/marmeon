import { randomBytes } from 'node:crypto';

/**
 * What the recorder keeps: one entry per request, query, job, mail, … — every value in it redacted before it was
 * written. Entries of one request, job attempt, scheduled run or command share a `batch`; `requestId` ties a
 * request to the jobs it dispatched, also when a worker in another process ran them.
 */
export interface Entry<T extends EntryType = EntryType> {
  /** Unique, sortable by time: `<time base36><counter><random>`. */
  readonly id: string;
  readonly type: T;
  /** When it started (epoch ms, sub-millisecond). */
  readonly at: number;
  /** What it belongs to: a request (in-process islands and layer bases join their page's), a job attempt, a scheduled run, a command. */
  readonly batch: string;
  /** The request it happened in — or, for a job's entries, the request that dispatched the job. */
  readonly requestId?: string;
  /** The job it happened in (or, for a `job` entry, the job's id). */
  readonly jobId?: string;
  /** Short labels to filter by: `status:500`, `route:users.show`, `slow`, `failed`, a job's or mail's name. */
  readonly tags: readonly string[];
  readonly content: EntryContents[T];
}

/** Any entry — narrowed by its `type`. */
export type AnyEntry = { [T in EntryType]: Entry<T> }[EntryType];

/** The kinds of entries and what each holds. */
export interface EntryContents {
  request: RequestEntryContent;
  query: QueryEntryContent;
  job: JobEntryContent;
  mail: MailEntryContent;
  notification: NotificationEntryContent;
  log: LogEntryContent;
  exception: ExceptionEntryContent;
  schedule: ScheduleEntryContent;
  live: LiveEntryContent;
  event: EventEntryContent;
  command: CommandEntryContent;
}

export type EntryType = keyof EntryContents;

export const ENTRY_TYPES: readonly EntryType[] = ['request', 'query', 'job', 'mail', 'notification', 'log', 'exception', 'schedule', 'live', 'event', 'command'];

/** A failure, as shown: never the error object itself. */
export interface ErrorDetails {
  readonly class: string;
  readonly message: string;
  readonly stack?: string;
}

export interface RequestEntryContent {
  readonly method: string;
  /** The URL as requested: sensitive route parameters (`:token`) and query values replaced. */
  readonly url: string;
  readonly path: string;
  readonly route?: string;
  readonly routePath?: string;
  readonly controller?: string;
  readonly status?: number;
  readonly durationMs?: number;
  /**
   * Where the response sent the browser (redacted like the URL): a redirect's target, or — with a 409 — where a visit reloads
   * fully (the protocol's answer after a new build or across the sign-in boundary: no failure).
   */
  readonly location?: string;
  /** With a 409 and a location: why the browser reloads — `version` (a new build) or `history` (signed in or out). */
  readonly reload?: string;
  /** `island` or `layer`: a region's request. */
  readonly region?: string;
  /** Resolved in-process for another request (an island while its page renders, a layer's base). */
  readonly inProcess: boolean;
  /** The request's headers — `cookie`, `authorization`, `x-xsrf-token` … replaced. */
  readonly headers: Readonly<Record<string, string>>;
  /** The query string's values (`token=…` replaced). */
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  /** The body as the app read it: passwords and tokens replaced, files by their size. */
  readonly input?: unknown;
  /** The page or island it answered with: its view and the size of each prop (bytes of JSON), never their values. */
  readonly page?: {
    readonly kind: 'page' | 'layer' | 'island';
    readonly component: string;
    readonly props: Readonly<Record<string, number>>;
    readonly bytes: number;
    readonly only?: readonly string[];
    readonly except?: readonly string[];
    readonly deferred?: Readonly<Record<string, readonly string[]>>;
    /** Sent props that are shared (`SharedData`), not the controller's own. */
    readonly shared?: readonly string[];
    /** `optional()` props left out (sent only when a partial reload names them). */
    readonly optional?: readonly string[];
  };
  /** Server rendering of its page. */
  readonly ssr?: { readonly component: string; readonly durationMs?: number; readonly streamed?: boolean; readonly complete: boolean; readonly failed?: boolean };
  /** Entries of this batch not kept (more than the recorder keeps per batch). */
  readonly dropped?: number;
  readonly error?: ErrorDetails;
}

export interface QueryEntryContent {
  readonly connection: string;
  readonly driver: string;
  readonly sql: string;
  /** The bound values — none of them when the statement touches a table with secret columns (`sensitive`). */
  readonly parameters: readonly unknown[];
  /** The statement touches a table with secret columns: every parameter is replaced. */
  readonly sensitive: boolean;
  readonly durationMs: number;
  /** At or over `slowQueryMs`. */
  readonly slow: boolean;
  readonly error?: ErrorDetails;
}

export interface JobEntryContent {
  /** `queued` (dispatched), then per attempt: `done`, `failed`, `released`, `discarded`. */
  readonly status: 'queued' | 'done' | 'failed' | 'released' | 'discarded';
  /** `static job`. */
  readonly name: string;
  readonly queue: string;
  readonly connection: string;
  /** From 1 — attempts only. */
  readonly attempt?: number;
  /** `dispatch`, `bulk` or `chain` — dispatches only. */
  readonly kind?: 'dispatch' | 'bulk' | 'chain';
  /** Seconds before it may run — dispatches only. */
  readonly delaySeconds?: number;
  readonly unique?: string;
  /** The payload, redacted — an encrypted job's is `[encrypted]`, never its contents. */
  readonly payload?: unknown;
  /** The request that dispatched it (attempts). */
  readonly originRequestId?: string;
  readonly durationMs?: number;
  readonly error?: ErrorDetails;
}

export interface MailEntryContent {
  /** The mailable's class. */
  readonly mailable: string;
  /** `send` (now), `queue` (composed now, sent by a worker), `worker` (the queued mail, sent). */
  readonly mode: 'send' | 'queue' | 'worker';
  readonly from?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject?: string;
  /** The body — links with signatures or tokens in them masked. */
  readonly html?: string;
  readonly text?: string;
  readonly attachments: readonly { readonly filename: string; readonly bytes: number; readonly contentType?: string }[];
  readonly durationMs?: number;
  readonly error?: ErrorDetails;
}

export interface NotificationEntryContent {
  readonly notification: string;
  readonly id: string;
  readonly recipient: { readonly type: string; readonly id: string | number };
  /** Queued by `send` (delivered later), not delivered now. */
  readonly queued: boolean;
  readonly channels?: readonly string[];
  readonly outcome?: 'delivered' | 'gone' | 'delivered-before';
  readonly durationMs?: number;
  readonly error?: ErrorDetails;
}

export interface LogEntryContent {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  /** The logger's bindings and the entry's context, redacted. */
  readonly context: Readonly<Record<string, unknown>>;
}

export interface ExceptionEntryContent extends ErrorDetails {
  /** Where it ended: a request (`status`, `method`, `path`), a job, a scheduled task or a command. */
  readonly in: 'request' | 'job' | 'schedule' | 'command';
  readonly status?: number;
  readonly method?: string;
  readonly path?: string;
  /** What to do about it, as the error page shows it — text only. */
  readonly solutions: readonly { readonly title: string; readonly text: string; readonly command?: string; readonly docs?: string }[];
}

export interface ScheduleEntryContent {
  readonly task: string;
  /** The minute it was due (epoch ms). */
  readonly minute: number;
  readonly reason: 'due' | 'catch-up' | 'test';
  readonly outcome?: 'ran' | 'skipped' | 'failed';
  readonly skipped?: string;
  readonly durationMs?: number;
  readonly error?: ErrorDetails;
}

export interface LiveEntryContent {
  readonly channel: string;
  /** The props it names; `null`: every prop each follower follows. */
  readonly only: readonly string[] | null;
  readonly durationMs?: number;
  readonly error?: ErrorDetails;
}

export interface EventEntryContent {
  /** `static event`, else the class name. */
  readonly name: string;
  readonly class: string;
  /** The event's own fields, redacted. */
  readonly payload: unknown;
  readonly listeners: readonly string[];
}

export interface CommandEntryContent {
  readonly command: string;
  /** Its arguments, redacted (`--password=…`). */
  readonly args: readonly string[];
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly error?: ErrorDetails;
}

/**
 * Entry ids sort by time: the start in ms (base 36, fixed width), a counter for entries of the same millisecond, and random
 * bytes so ids from several processes never collide. One generator per recorder (no module state).
 */
export class EntryIds {
  #last = 0;
  #counter = 0;

  next(at: number): string {
    const ms = Math.floor(at);
    this.#counter = ms === this.#last ? this.#counter + 1 : 0;
    this.#last = ms;
    return `${ms.toString(36).padStart(9, '0')}${(this.#counter % 1296).toString(36).padStart(2, '0')}${randomBytes(5).toString('hex')}`;
  }
}

/** Newest first: by start, then by id. */
export function newestFirst(a: { readonly at: number; readonly id: string }, b: { readonly at: number; readonly id: string }): number {
  return b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}
