/**
 * Invented sample data for the landing page's devtools picture. Page names, tab names and columns follow the real devtools
 * (`packages/devtools`); `devtools-sample.test.ts` fails when the framework renames one. A value the core redactor
 * hides shows as `[redacted]`, as in the devtools.
 */

/** What the devtools show in place of a redacted value (`REDACTED` of `@marmeon/core`). */
export const REDACTED = '[redacted]';

export interface SampleRequest {
  readonly time: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
  readonly route: string;
  readonly answer: string;
}

export interface SampleQuery {
  readonly time: string;
  readonly statement: string;
  readonly ms: number;
  readonly origin: string;
}

/** The statuses of a job entry (`JobEntryContent` of the devtools). */
export type SampleJobStatus = 'queued' | 'done' | 'failed' | 'released' | 'discarded';

export interface SampleJob {
  readonly time: string;
  readonly job: string;
  readonly status: SampleJobStatus;
  readonly queue: string;
  readonly attempt: number;
  readonly ms: number;
  readonly origin: string;
}

export interface SampleMail {
  readonly time: string;
  readonly mail: string;
  readonly subject: string;
  readonly to: string;
  readonly mode: 'send' | 'queue' | 'worker';
  readonly origin: string;
}

export interface SampleLog {
  readonly time: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly origin: string;
}

export interface SampleException {
  readonly time: string;
  readonly exception: string;
  readonly message: string;
  readonly where: string;
  readonly origin: string;
}

/** One row of a block of the in-page bar: its cells in the order of the block's columns. */
export interface SampleBarRow {
  readonly cells: readonly string[];
}

/** A block of a bar tab: an optional heading and note, then a table (with a head when it has `columns`). */
export interface SampleBarBlock {
  readonly heading?: string;
  readonly note?: string;
  readonly columns?: readonly string[];
  readonly rows?: readonly SampleBarRow[];
}

export interface DevtoolsSamplePage {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface DevtoolsSampleBarTab {
  readonly name: string;
  readonly blocks: readonly SampleBarBlock[];
}

const REQUESTS: readonly SampleRequest[] = [
  { time: '10:41:07.212', method: 'GET', path: '/guests', status: 200, ms: 18, route: 'guests.index', answer: 'Guests/Index' },
  { time: '10:41:09.540', method: 'POST', path: '/guests', status: 303, ms: 41, route: 'guests.store', answer: '' },
  { time: '10:41:09.611', method: 'GET', path: '/guests/7', status: 200, ms: 12, route: 'guests.show', answer: 'Guests/Show' },
  { time: '10:41:15.034', method: 'DELETE', path: '/guests/7', status: 403, ms: 4, route: 'guests.destroy', answer: '' },
];

const QUERIES: readonly SampleQuery[] = [
  { time: '10:41:07.220', statement: 'select * from guests order by id desc limit 50', ms: 2.1, origin: 'request 5d1c9a02' },
  { time: '10:41:07.224', statement: 'select count(*) from guests', ms: 0.8, origin: 'request 5d1c9a02' },
  { time: '10:41:09.552', statement: 'insert into guests (name, email) values (?, ?)', ms: 1.4, origin: 'request 7be40f13' },
  { time: '10:41:09.602', statement: "select user_id from sessions where session_id = '[redacted]'", ms: 0.4, origin: 'request c28a6e71' },
  { time: '10:41:09.618', statement: 'select * from guests where id = ?', ms: 0.6, origin: 'request c28a6e71' },
];

const JOBS: readonly SampleJob[] = [
  { time: '10:41:09.560', job: 'SendWelcomeMail', status: 'queued', queue: 'default/mail', attempt: 0, ms: 0, origin: 'request 7be40f13' },
  { time: '10:41:09.904', job: 'SendWelcomeMail', status: 'done', queue: 'default/mail', attempt: 1, ms: 120, origin: 'request 7be40f13' },
  { time: '10:41:12.310', job: 'SyncGuestList', status: 'released', queue: 'default/sync', attempt: 1, ms: 340, origin: 'request 7be40f13' },
  { time: '10:41:20.118', job: 'PruneOldGuests', status: 'failed', queue: 'default/default', attempt: 3, ms: 85, origin: '' },
];

const MAILS: readonly SampleMail[] = [
  { time: '10:41:09.556', mail: 'WelcomeMail', subject: 'Welcome to the guest list', to: 'ada@example.com', mode: 'queue', origin: 'request 7be40f13' },
  { time: '10:41:09.902', mail: 'WelcomeMail', subject: 'Welcome to the guest list', to: 'ada@example.com', mode: 'worker', origin: 'job 0f3a91c4' },
];

const LOGS: readonly SampleLog[] = [
  { time: '10:41:09.548', level: 'info', message: 'Guest 7 created', origin: 'request 7be40f13' },
  { time: '10:41:09.600', level: 'info', message: 'Session resumed session_id=[redacted]', origin: 'request c28a6e71' },
  { time: '10:41:07.231', level: 'warn', message: 'Slow query: 212 ms', origin: 'request 5d1c9a02' },
  { time: '10:41:20.120', level: 'error', message: 'PruneOldGuests failed, retrying', origin: 'job 9c71d0aa' },
];

const EXCEPTIONS: readonly SampleException[] = [
  { time: '10:41:20.119', exception: 'TimeoutError', message: 'The sync did not answer within 5 s', where: 'job', origin: 'job 9c71d0aa' },
  { time: '10:41:15.036', exception: 'ForbiddenError', message: 'Only an admin may remove a guest', where: 'request 403 /guests/7', origin: 'request e4a0b5d6' },
];

const ms = (value: number) => (value === 0 ? '' : `${value} ms`);

/** The pages of `/_marmeon/devtools`, in the navigation's order. */
export const DEVTOOLS_PAGES: readonly DevtoolsSamplePage[] = [
  {
    name: 'Requests',
    columns: ['Time', 'Method', 'Path', 'Status', 'Duration', 'Route', 'Answer'],
    rows: REQUESTS.map((r) => [r.time, r.method, r.path, String(r.status), ms(r.ms), r.route, r.answer]),
  },
  {
    name: 'Queries',
    columns: ['Time', 'Statement', 'Duration', 'Origin'],
    rows: QUERIES.map((r) => [r.time, r.statement, ms(r.ms), r.origin]),
  },
  {
    name: 'Jobs',
    columns: ['Time', 'Job', 'Status', 'Queue', 'Attempt', 'Duration', 'Origin'],
    rows: JOBS.map((r) => [r.time, r.job, r.status, r.queue, r.attempt === 0 ? '' : String(r.attempt), ms(r.ms), r.origin]),
  },
  {
    name: 'Mails',
    columns: ['Time', 'Mail', 'Subject', 'To', 'Mode', 'Origin'],
    rows: MAILS.map((r) => [r.time, r.mail, r.subject, r.to, r.mode, r.origin]),
  },
  {
    name: 'Logs',
    columns: ['Time', 'Level', 'Message', 'Origin'],
    rows: LOGS.map((r) => [r.time, r.level, r.message, r.origin]),
  },
  {
    name: 'Exceptions',
    columns: ['Time', 'Exception', 'Message', 'Where', 'Origin'],
    rows: EXCEPTIONS.map((r) => [r.time, r.exception, r.message, r.where, r.origin]),
  },
];

const row = (...cells: string[]): SampleBarRow => ({ cells });

/** The tabs of the in-page bar, in the bar's order — showing the landing page and its live island. */
export const DEVTOOLS_BAR_TABS: readonly DevtoolsSampleBarTab[] = [
  {
    name: 'Visits',
    blocks: [
      {
        columns: ['Kind', 'Request', 'Status', 'Time', 'Details'],
        rows: [row('document', 'GET /', '200', '23 ms', 'Landing'), row('island', 'GET /islands/render-clock', '200', '6 ms', 'only clock')],
      },
    ],
  },
  {
    name: 'Page',
    blocks: [
      {
        heading: 'Page: Landing',
        columns: ['Props', 'Size'],
        rows: [row('version', '8 B'), row('viewer', '1.1 kB')],
      },
    ],
  },
  {
    name: 'Layers & regions',
    blocks: [
      {
        heading: 'Page: Landing /',
        columns: ['Island', 'Status', 'View', 'Size'],
        rows: [row('/islands/render-clock', 'ready', 'site/islands/RenderClock', '312 B')],
      },
    ],
  },
  {
    name: 'Optimistic',
    blocks: [
      {
        columns: ['#', 'With', 'State', 'Changed', 'Before', 'Shown'],
        rows: [
          row('2', 'island GET /islands/render-clock → 200', 'replaced by the server', 'clock', '{"clock":"10:41:07"}', '{"clock":"10:41:08"}'),
          row('1', 'island GET /islands/render-clock', 'rolled back', 'clock', '{"clock":"10:41:07"}', '{"clock":"10:41:09"}'),
        ],
      },
    ],
  },
  {
    name: 'Server',
    blocks: [
      { note: 'GET / → 200 in 23 ms · route home · Landing · SSR 9 ms' },
      { heading: 'Queries (1)', rows: [row('0.6 ms · select slug, title from pages where slug = ?')] },
      { heading: 'Log (1)', rows: [row('info · Landing rendered')] },
    ],
  },
  {
    name: 'SSR',
    blocks: [
      { heading: 'Server rendering of this document', note: 'Landing: 9 ms' },
      { heading: 'Hydration (0)', note: 'No hydration errors — the server’s markup matched.' },
    ],
  },
];

/** Every string of the sample data, nested rows and blocks included. */
export function sampleValues(): string[] {
  const values: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(DEVTOOLS_PAGES);
  walk(DEVTOOLS_BAR_TABS);
  return values;
}
