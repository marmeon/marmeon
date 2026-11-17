/**
 * The pictures of the landing's batteries section, drawn by `BatteriesSection`. Only what the page shows is here; `batteries.test.ts`
 * holds where each name comes from and checks it: the job classes and their `tries`, the mail's English texts, the schedule files'
 * cadences, the storage config, the controller's disk and link time, the table's columns against the migration snippet, and the
 * message `@marmeon/validation` gives. The states, durations and the e-mail address are illustrative.
 */
export type JobStatus = 'done' | 'running' | 'retry';

export interface JobRow {
  readonly name: string;
  readonly status: JobStatus;
  readonly state: string;
}

export interface ScheduleRow {
  readonly when: string;
  readonly what: string;
}

export const NOTES_TABLE = {
  name: 'notes',
  rows: [
    { name: 'id', type: 'id' },
    { name: 'user_id', type: 'foreign → users' },
    { name: 'title', type: 'string(120)' },
    { name: 'body', type: 'text' },
    { name: 'pinned', type: 'boolean' },
    { name: 'timestamps', type: 'created · updated' },
  ],
} as const;

export const JOBS: readonly JobRow[] = [
  { name: 'SendPasswordResetLinkJob', status: 'done', state: 'done · 96 ms' },
  { name: 'SendWelcomeMailJob', status: 'running', state: 'running' },
  { name: 'RebuildMemberStatsJob', status: 'retry', state: 'retry 2 of 5' },
];

export const MAIL = {
  to: 'ada@example.com',
  subject: 'Confirm your e-mail address',
  button: 'Confirm my e-mail address',
} as const;

export const VALIDATION = {
  field: 'title',
  label: 'Title',
  max: 120,
  value: 'Groceries for the whole week, the weekend and the days after, with the list for the market, the bakery and the florist on top of it',
  error: 'The title field must not be longer than 120 characters.',
} as const;

export const SCHEDULE: readonly ScheduleRow[] = [
  { when: '03:10', what: 'auth:prune-tokens' },
  { when: 'hourly', what: 'RebuildMemberStatsJob' },
  { when: 'every 15 min', what: 'session:prune' },
];

export const STORAGE = {
  disks: ['local', 's3'],
  active: 'local',
  key: 'exports/user-7.json',
  minutes: 5,
} as const;
