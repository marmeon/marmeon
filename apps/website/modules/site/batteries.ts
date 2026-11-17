/**
 * The pictures of the landing's batteries section, drawn by `BatteriesSection`. Only what the page shows is here; `batteries.test.ts`
 * holds where each name comes from and checks it: the job classes and their `tries`, the mail's English texts, the schedule files'
 * cadences, the storage config, the controller's disk and link time, the table's columns against the migration snippet, and the
 * message `@marmeon/validation` gives, the profile page's channel and props, the notification's channels, the translations and the
 * cache key with its time to live. The states, durations and the e-mail address are illustrative.
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

/** The profile page follows `users.<public_id>`; a write hints it, and the tab reloads the `profile` prop. The names of the links are illustrative. */
export const LIVE = {
  page: 'user-profile/Show',
  channel: 'users.<public_id>',
  prop: 'profile',
  links: ['Website', 'Mastodon'],
  added: 'Newsletter',
} as const;

/**
 * One notification and what each of its channels delivers: the bell's entry (`notifications.new_sign_in`), the open tabs'
 * reload, and the mail's subject (`auth.mail.new_sign_in.subject` with the app's name). The address and browser are illustrative.
 */
export const NOTIFICATION = {
  name: 'auth.new-sign-in',
  className: 'NewSignInNotification',
  channels: [
    { name: 'database', where: 'in the bell', text: 'New sign-in to your account', detail: 'From 203.0.113.7 · Firefox · macOS' },
    { name: 'live', where: 'in open tabs', text: 'The bell and the list reload', detail: null },
    { name: 'mail', where: 'subject, to a confirmed address', text: 'A new sign-in to Marmeon', detail: null },
  ],
} as const;

/** A key in the two languages the web app ships, and a number in each locale's format. */
export const I18N = {
  key: 'auth.verify.title',
  texts: [
    { locale: 'en', text: 'Confirm your e-mail address' },
    { locale: 'de', text: 'E-Mail-Adresse bestätigen' },
  ],
  number: 1234.5,
  numbers: [
    { locale: 'en', text: '1,234.5' },
    { locale: 'de', text: '1.234,5' },
  ],
} as const;

const CACHE_SECONDS = 300;

/** The member numbers' snapshot of the dashboard: a read that finds it, and one that counts again and keeps the result. */
export const CACHE = {
  key: 'member-stats',
  seconds: CACHE_SECONDS,
  hit: 'hit: the stored numbers',
  miss: `miss: counted again, stored for ${CACHE_SECONDS} s`,
} as const;
