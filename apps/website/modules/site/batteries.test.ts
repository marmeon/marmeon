import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rules as r } from '@marmeon/validation';
import { describe, expect, it } from 'vitest';
import { CACHE, I18N, JOBS, LIVE, MAIL, NOTES_TABLE, NOTIFICATION, SCHEDULE, STORAGE, VALIDATION } from './batteries.ts';
import { SNIPPETS } from './snippets.ts';

const repo = resolve(import.meta.dirname, '../../../..');
/** Where each job lives in `apps/web-app`. */
const JOB_FILES: Record<string, string> = {
  SendPasswordResetLinkJob: 'apps/web-app/modules/auth/jobs/SendPasswordResetLinkJob.ts',
  SendWelcomeMailJob: 'apps/web-app/modules/auth/jobs/SendWelcomeMailJob.ts',
  RebuildMemberStatsJob: 'apps/web-app/modules/user-profile/jobs/RebuildMemberStatsJob.ts',
};
/** Each schedule row: the file, the entry's name part and the cadence call, word for word. */
const SCHEDULE_SOURCES: Record<string, { file: string; entry: string; cadence: string }> = {
  'auth:prune-tokens': { file: 'apps/web-app/modules/auth/schedule.ts', entry: "s.command('auth:prune-tokens')", cadence: ".daily().at('03:10')" },
  RebuildMemberStatsJob: { file: 'apps/web-app/modules/user-profile/schedule.ts', entry: 's.job(RebuildMemberStatsJob)', cadence: '.hourly()' },
  'session:prune': { file: 'apps/web-app/modules/system/schedule.ts', entry: "s.command('session:prune')", cadence: '.everyFifteenMinutes()' },
};
/** What the card's `when` says, as the schedule file spells it. */
const WHEN: Record<string, string> = { '03:10': ".at('03:10')", hourly: '.hourly()', 'every 15 min': '.everyFifteenMinutes()' };
const read = (file: string): string => readFileSync(resolve(repo, file), 'utf8');

describe('the batteries pictures show things that exist', () => {
  it('names jobs that are classes of apps/web-app, and shows the retry on a job that declares its tries', () => {
    expect(JOBS).toHaveLength(3);
    for (const { name } of JOBS) {
      const file = JOB_FILES[name]!;
      expect(file.endsWith(`/${name}.ts`), name).toBe(true);
      expect(read(file), name).toMatch(new RegExp(`export class ${name}\\b`));
    }
    expect(JOBS.map((job) => job.status)).toEqual(['done', 'running', 'retry']);
    const retry = JOBS.find((job) => job.status === 'retry')!;
    const tries = /static readonly tries = (\d+);/.exec(read(JOB_FILES[retry.name]!));
    expect(tries, `${retry.name} declares tries`).not.toBeNull();
    expect(Number(tries![1])).toBeGreaterThan(1);
    expect(retry.state).toMatch(/^retry \d+ of (\d+)$/);
    expect(retry.state.endsWith(`of ${tries![1]}`)).toBe(true);
    for (const { state, status } of JOBS) expect(state, status).toContain(status);
  });

  it("takes the mail's subject and button from the verification mail's English texts", () => {
    const lang = read('apps/web-app/modules/auth/lang/en.ts');
    // `auth.mail.verify`: the `verify` block inside `mail`.
    const mail = lang.slice(lang.indexOf('\n  mail: {'));
    const verify = mail.slice(mail.indexOf('verify: {'), mail.indexOf('},', mail.indexOf('verify: {')));
    expect(verify).toContain(`subject: '${MAIL.subject}'`);
    expect(verify).toContain(`button: '${MAIL.button}'`);
    expect(read('apps/web-app/modules/auth/mail/VerifyEmailView.tsx')).toContain("t.get('auth.mail.verify.button')");
    expect(read('apps/web-app/modules/auth/mail/VerifyEmailMail.ts')).toContain("'auth.mail.verify.subject'");
  });

  it("derives the table's types from the migration snippet; the id row follows the docs' notes migration", () => {
    const columns = SNIPPETS.migrationColumns.code;
    // The landing's notes migration is the smoke app's file; the repository has the docs' version, which starts with `table.id()` before `user_id`.
    const docs = read('docs/migrations.md').slice(0, 800);
    expect(docs.indexOf('table.id();')).toBeGreaterThan(-1);
    expect(docs.indexOf('table.id();')).toBeLessThan(docs.indexOf("table.foreignId('user_id')"));
    const derived = [
      ['id', 'id'],
      ['user_id', `foreign → ${/table\.foreignId\('user_id'\)\.constrained\('(\w+)'\)/.exec(columns)![1]}`],
      ['title', `string(${/table\.string\('title', (\d+)\);/.exec(columns)![1]})`],
      ['body', columns.includes("table.text('body');") ? 'text' : '?'],
      ['pinned', columns.includes("table.boolean('pinned')") ? 'boolean' : '?'],
      ['timestamps', columns.includes('table.timestamps();') ? 'created · updated' : '?'],
    ];
    expect(NOTES_TABLE.rows.map((row) => [row.name, row.type])).toEqual(derived);
  });

  it('pins each schedule row to its entry and its cadence in the schedule file, word for word', () => {
    expect(SCHEDULE).toHaveLength(3);
    for (const { when, what } of SCHEDULE) {
      const { file, entry, cadence } = SCHEDULE_SOURCES[what]!;
      expect(WHEN[when], when).toBeDefined();
      expect(cadence, what).toContain(WHEN[when]!);
      expect(read(file), what).toContain(`${entry}${cadence}`);
    }
  });

  it('shows the disks of the web app and the key of its data export, with the disk and link time of its controller', () => {
    const config = read('apps/web-app/config/storage.ts');
    for (const disk of STORAGE.disks) expect(config, disk).toMatch(new RegExp(`\\b${disk}: \\{`));
    expect(STORAGE.disks).toContain(STORAGE.active);
    const controller = read('apps/web-app/modules/user-profile/controllers/ExportMyDataController.ts');
    expect(controller).toContain(`.disk('${STORAGE.active}')`);
    expect(controller).toContain('`exports/user-${userId}.json`');
    expect(STORAGE.key).toMatch(/^exports\/user-\d+\.json$/);
    expect(controller).toContain(`expiresIn: { minutes: ${STORAGE.minutes} }`);
  });

  it('shows the message @marmeon/validation gives for a title over 120 characters', async () => {
    const form = r.object({ [VALIDATION.field]: r.string().max(VALIDATION.max) });
    const result = await form['~standard'].validate({ [VALIDATION.field]: VALIDATION.value });
    expect(result.issues?.map((issue) => issue.message)).toEqual([VALIDATION.error]);
  });

  it('shows the channel and props the profile page follows, and the write that hints them', () => {
    const live = read('apps/web-app/modules/user-profile/live.ts');
    // `users.<public_id>` is the channel's shape; the page and the hint use it through `profileChannel`.
    expect(live).toContain('export const profileChannel = (publicId: string) => `users.${publicId}`;');
    expect(LIVE.channel).toBe('users.<public_id>');
    const show = read('apps/web-app/modules/user-profile/controllers/ShowUserProfileController.ts');
    expect(show).toContain(`this.view('${LIVE.page}'`);
    expect(show).toMatch(new RegExp(`\\.live\\(profileChannel\\(user\\.public_id\\), \\{ only: \\[[^\\]]*'${LIVE.prop}'`));
    expect(read('apps/web-app/modules/user-profile/controllers/AddProfileLinkController.ts')).toContain(`this.#broadcast.refresh(profileChannel(ctx.params.user.public_id), { only: ['${LIVE.prop}'] })`);
    // The docs say the same: a hint reloads the props it names, and says that something changed, never what.
    expect(read('docs/realtime.md')).toContain('A hint says *that* something changed, never *what*');
  });

  it('shows the channels the sign-in notification takes, and what each delivers, from its class and its texts', () => {
    const file = read('apps/web-app/modules/auth/notifications/NewSignInNotification.ts');
    expect(file).toContain(`static readonly notification = '${NOTIFICATION.name}';`);
    expect(file).toContain(`export class ${NOTIFICATION.className} `);
    // `via()` lists them in this order; the mail only for a confirmed address.
    expect(file).toContain(`(['${NOTIFICATION.channels.map((channel) => channel.name).join("', '")}'] as const)`);
    expect(file).toContain('user.email_verified_at !== null ?');
    const [database, live, mail] = NOTIFICATION.channels;
    // The bell's entry: the `new_sign_in` block of the notifications texts (title, and the body with the address and the browser).
    const texts = read('apps/web-app/modules/notifications/lang/en.ts');
    const signIn = texts.slice(texts.indexOf('\n  new_sign_in: {'));
    const bell = signIn.slice(0, signIn.indexOf('\n  },'));
    expect(bell).toContain(`title: '${database.text}'`);
    expect(bell).toContain("body: 'From {ip} · {browser}'");
    expect(database.detail).toMatch(/^From \S+ · .+$/);
    // The open tabs reload the bell and the list: the page of the list follows the user's notifications channel for `notifications`, the shared `bell` prop follows it from the middleware.
    expect(read('apps/web-app/modules/notifications/controllers/ShowNotificationsController.ts')).toContain(".live(notificationsChannel(me), { only: ['notifications'] })");
    const shared = read('apps/web-app/middleware/ShareAppProps.ts');
    expect(shared).toContain("notificationsChannel({ type: 'user', id: user.id })");
    expect(shared).toContain("{ only: ['bell'] }");
    expect(live.text).toBe('The bell and the list reload');
    // The mail: `auth.mail.new_sign_in.subject` with the app's name, from the app's language file.
    const lang = read('apps/web-app/modules/auth/lang/en.ts');
    const mailBlock = lang.slice(lang.indexOf('\n    new_sign_in: {'));
    expect(mailBlock.slice(0, mailBlock.indexOf('\n    },'))).toContain("subject: 'A new sign-in to {app}'");
    expect(read('apps/web-app/lang/en.ts')).toContain("name: 'Marmeon'");
    expect(mail.text).toBe('A new sign-in to Marmeon');
    expect(mail.where).toContain('subject');
    expect(read('apps/web-app/modules/auth/mail/NewSignInMail.ts')).toContain("'auth.mail.new_sign_in.subject'");
  });

  it("takes the key's texts from the web app's language files, and the number from the locales' own format", () => {
    for (const { locale, text } of I18N.texts) {
      const lang = read(`apps/web-app/modules/auth/lang/${locale}.ts`);
      // `auth.verify.title`: `title` of the top-level `verify` block (two spaces in), not of `mail.verify`.
      const block = lang.slice(lang.indexOf('\n  verify: {'));
      expect(block.slice(0, block.indexOf('\n  },')), locale).toContain(`title: '${text}'`);
    }
    expect(I18N.key).toBe('auth.verify.title');
    for (const { locale, text } of I18N.numbers) expect(new Intl.NumberFormat(locale).format(I18N.number), locale).toBe(text);
    expect(read('docs/localization.md')).toContain('format.number(1234.5);');
  });

  it("shows the cache key and time to live of the dashboard's member numbers, and the two ends of a read", () => {
    const file = read('apps/web-app/modules/user-profile/MemberStats.ts');
    expect(file).toContain(`const KEY = '${CACHE.key}';`);
    expect(file).toContain(`const MAX_AGE = ${CACHE.seconds};`);
    expect(file).toContain('(await this.#cache.get<MemberNumbers>(KEY)) ?? this.rebuild()');
    expect(file).toContain('await this.#cache.put(KEY, numbers, MAX_AGE)');
    expect(CACHE.miss).toBe(`miss: counted again, stored for ${CACHE.seconds} s`);
  });
});
