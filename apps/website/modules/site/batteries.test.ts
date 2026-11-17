import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rules as r } from '@marmeon/validation';
import { describe, expect, it } from 'vitest';
import { JOBS, MAIL, NOTES_TABLE, SCHEDULE, STORAGE, VALIDATION } from './batteries.ts';
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
});
