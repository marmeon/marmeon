import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marmeon, repo, tsc, webApp } from './__fixtures__/cli.js';

/** The part of a generated mail this test reads. */
interface Mailable {
  envelope(): unknown;
  content(): unknown;
}

describe('marmeon make:* (generated code compiles)', { timeout: 30_000 }, () => {
  let app: string;

  beforeAll(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-make-')));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@marmeon/auth': 'workspace:*', '@marmeon/mail': 'workspace:*', '@marmeon/i18n': 'workspace:*' } }));
    // Resolve the framework and React like an installed app would.
    const link = (name: string, target: string) => {
      mkdirSync(dirname(join(app, 'node_modules', name)), { recursive: true });
      symlinkSync(target, join(app, 'node_modules', name), 'dir');
    };
    for (const pkg of ['core', 'auth', 'http','router', 'database', 'queue', 'notifications', 'validation', 'testing', 'react', 'mail', 'i18n', 'table']) link(`@marmeon/${pkg}`, join(repo, 'packages', pkg));
    link('mjml', realpathSync(join(repo, 'packages/mail/node_modules/mjml'))); // the mail's layout is compiled by it
    link('vitest', realpathSync(join(repo, 'node_modules/vitest'))); // the generated test imports it
    link('marmeon', join(repo, 'packages', 'cli')); // the generated command imports its input type from it
    for (const pkg of ['react', '@types/react']) link(pkg, realpathSync(join(webApp, 'node_modules', pkg)));
    link('@types/node', realpathSync(join(repo, 'node_modules/@types/node'))); // the framework sources need them
    writeFileSync(
      join(app, 'tsconfig.json'),
      JSON.stringify({
        extends: join(repo, 'tsconfig.base.json'),
        compilerOptions: { noEmit: true, jsx: 'react-jsx', lib: ['ES2025', 'ESNext.Temporal', 'ESNext.TypedArrays', 'DOM'], types: ['node'] },
        include: ['modules'],
      }),
    );
  });
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  it('scaffolds a module, controller with view, event, listener, middleware, job and notification', () => {
    expect(marmeon(app, ['make:module', 'billing']).stdout).toContain("import billing from '#modules/billing';");
    expect(marmeon(app, ['make:controller', 'ShowInvoice', '--module=billing', '--view']).code).toBe(0);
    expect(marmeon(app, ['make:event', 'InvoicePaid', '-m', 'billing']).code).toBe(0);
    expect(marmeon(app, ['make:listener', 'SendReceipt', '--event=InvoicePaid', '--module=billing']).stdout).toContain(
      '✓ Registered SendReceipt in modules/billing/index.ts (listeners)',
    );
    expect(marmeon(app, ['make:middleware', 'EnsureCustomer', '--module=billing']).code).toBe(0);
    // A policy names AuthUser, which an app declares once.
    writeFileSync(join(app, 'modules/billing/auth-types.ts'), "declare module '@marmeon/auth' { interface AuthTypes { user: { readonly id: number } } }\nexport {};\n");
    expect(marmeon(app, ['make:policy', 'Invoice', '--module=billing']).code).toBe(0);
    expect(marmeon(app, ['make:job', 'SendInvoiceReminder', '--module=billing']).stdout).toContain(
      '✓ Registered SendInvoiceReminderJob in modules/billing/index.ts (jobs)',
    );
    expect(marmeon(app, ['make:notification', 'InvoiceOverdue', '--module=billing']).stdout).toContain(
      '✓ Registered InvoiceOverdueNotification in modules/billing/index.ts (notifications)',
    );
    // make:command registers the app to see every command name, so it needs an entry (the other generators work without one).
    mkdirSync(join(app, 'bootstrap'));
    writeFileSync(join(app, 'bootstrap/app.ts'), "import { defineApplication } from '@marmeon/core';\nexport default defineApplication({ root: import.meta.dirname + '/..' });\n");
    expect(marmeon(app, ['make:command', 'PruneInvoices', '--module=billing']).stdout).toContain(
      '✓ Registered PruneInvoicesCommand in modules/billing/index.ts (commands)',
    );
    // An app that does not register the CLI's provider still knows the built-ins.
    mkdirSync(join(app, 'modules/make'));
    writeFileSync(join(app, 'modules/make/index.ts'), "import { defineModule } from '@marmeon/core';\nexport default defineModule({ name: 'make' });\n");
    const clash = marmeon(app, ['make:command', 'Seeder', '--module=make']);
    expect([clash.code, clash.stderr]).toEqual([1, expect.stringContaining('make:seeder is already the name of MakeSeederCommand (marmeon)')]);
    expect(existsSync(join(app, 'modules/make/commands'))).toBe(false);
    rmSync(join(app, 'modules/make'), { recursive: true });
    rmSync(join(app, 'bootstrap'), { recursive: true });
    expect(marmeon(app, ['make:seeder', 'Invoice', '--module=billing']).stdout).toContain(
      '✓ Registered InvoiceSeeder in modules/billing/index.ts (seeders)',
    );
    const updateInvoice = marmeon(app, ['make:controller', 'UpdateInvoice', '--module=billing', '--request']).stdout;
    expect(updateInvoice).toContain("Route.post('/…', UpdateInvoiceController)");
    // The generator decides nothing for the app: it says where the decision goes.
    expect(updateInvoice).toContain('Route.authorize');
    // A reading endpoint is a GET, and a GET has no body: its request validates the query.
    expect(marmeon(app, ['make:controller', 'ListInvoices', '--module=billing', '--request']).stdout).toContain("Route.get('/…', ListInvoicesController)");
    // A writing endpoint answers with a redirect: it renders no page — --view goes with a reading name, nothing is written.
    const writing = marmeon(app, ['make:controller', 'ArchiveInvoice', '--module=billing', '--request', '--view']);
    expect([writing.code, writing.stderr]).toEqual([
      2,
      '✗ --view renders a page, and ArchiveInvoiceController answers a form with a redirect (--request on a name that does not read). Name a reading endpoint (Show…, List…, Index…, Search…, Get…, Find…, Browse…, Create…, New…) for a page (Create… is the page of a form, Store… sends it), or leave out --view.\n',
    ]);
    expect(existsSync(join(app, 'modules/billing/controllers/ArchiveInvoiceController.ts'))).toBe(false);
    expect(existsSync(join(app, 'modules/billing/views/ArchiveInvoice.tsx'))).toBe(false);
    // Create… and New… name the page of a form: a query request and a page. Store… sends the form and stays refused.
    for (const page of ['CreateInvoice', 'NewInvoice']) {
      const made = marmeon(app, ['make:controller', page, '--module=billing', '--request', '--view']);
      expect([made.code, made.stdout]).toEqual([0, expect.stringContaining(`Route.get('/…', ${page}Controller)`)]);
      expect(readFileSync(join(app, `modules/billing/controllers/${page}Controller.ts`), 'utf8')).toContain('  query: r.query({');
      expect(existsSync(join(app, `modules/billing/views/${page}.tsx`))).toBe(true);
    }
    expect(marmeon(app, ['make:controller', 'StoreInvoice', '--module=billing', '--request', '--view']).code).toBe(2);
    expect(marmeon(app, ['make:migration', 'create_invoices_table', '--module=billing']).stdout).toContain(
      '✓ Registered the migrations folder in modules/billing/index.ts',
    );
    expect(marmeon(app, ['make:migration', 'add_due_date_to_invoices_table', '--module=billing']).code).toBe(0);
    expect(marmeon(app, ['make:migration', 'backfill_totals', '--module=billing']).code).toBe(0);
    expect(marmeon(app, ['make:migration', 'CreateInvoices', '--module=billing']).stderr).toContain('Pass a snake_case name');

    const controller = readFileSync(join(app, 'modules/billing/controllers/ShowInvoiceController.ts'), 'utf8');
    expect(controller).toContain("return this.view('billing/ShowInvoice', {});");
    expect(readFileSync(join(app, 'modules/billing/events/InvoicePaid.ts'), 'utf8')).toContain('readonly #event = true;');
    const job = readFileSync(join(app, 'modules/billing/jobs/SendInvoiceReminderJob.ts'), 'utf8');
    expect(job).toContain("static readonly job = 'billing.send-invoice-reminder';"); // stable, from the class name once
    expect(job).toContain('async handle(payload: JobPayload<typeof SendInvoiceReminderJob>, job: JobContext): Promise<void> {');
    const notification = readFileSync(join(app, 'modules/billing/notifications/InvoiceOverdueNotification.ts'), 'utf8');
    expect(notification).toContain("static readonly notification = 'billing.invoice-overdue';"); // stable, like a job's
    expect(notification).toContain('toDatabase(data: NotificationData<typeof InvoiceOverdueNotification>): DatabaseInput<typeof InvoiceOverdueNotification> {');
    const index = readFileSync(join(app, 'modules/billing/index.ts'), 'utf8');
    expect(index).toContain("import { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.ts';");
    expect(index).toContain("import { InvoiceOverdueNotification } from './notifications/InvoiceOverdueNotification.ts';");
    expect(index).toContain("import { InvoicePaid } from './events/InvoicePaid.ts';");
    expect(index).toContain("import { SendReceipt } from './listeners/SendReceipt.ts';");
    expect(index).toMatch(/listeners: \[listen\(InvoicePaid, SendReceipt\)\]/);
    expect(index).toContain("migrations: new URL('./migrations/', import.meta.url)");
    expect(index.match(/migrations:/g)).toHaveLength(1);
    expect(index).toMatch(/jobs: \[SendInvoiceReminderJob\]/);
    expect(index).toMatch(/notifications: \[InvoiceOverdueNotification\]/);
    expect(index).toMatch(/commands: \[PruneInvoicesCommand\]/);
    expect(index).toMatch(/seeders: \[InvoiceSeeder\]/);
    // The generated class passes the checks where a notification is sent (channels, toDatabase against static database).
    writeFileSync(
      join(app, 'modules/billing/send-overdue.ts'),
      [
        "import type { Notifications } from '@marmeon/notifications';",
        "import { InvoiceOverdueNotification } from './notifications/InvoiceOverdueNotification.ts';",
        "declare module '@marmeon/notifications' { interface NotificationRecipients { user: { readonly id: number } } }",
        'export const sendOverdue = (notifications: Notifications) => notifications.send({ type: \'user\', id: 7 }, InvoiceOverdueNotification, { id: 1 });',
        '',
      ].join('\n'),
    );
    const withRequest = readFileSync(join(app, 'modules/billing/controllers/UpdateInvoiceController.ts'), 'utf8');
    expect(withRequest).toContain('export const UpdateInvoiceRequest = defineRequest({');
    expect(withRequest).toContain('static request = UpdateInvoiceRequest;');
    expect(withRequest).toContain('handle(ctx: ContextOf<typeof UpdateInvoiceRequest>) {');
    expect(withRequest).toContain('  schema: r.object({');
    expect(withRequest).not.toContain('authorize');
    expect(withRequest).not.toContain('=> true');
    const withQuery = readFileSync(join(app, 'modules/billing/controllers/ListInvoicesController.ts'), 'utf8');
    expect(withQuery).toContain('  query: r.query({');
    expect(withQuery).not.toContain('schema:');
    expect(withQuery).not.toContain('authorize');
    expect(withQuery).toContain('return this.json({ q: ctx.query.q, page: ctx.query.page });');

    // Generated in quick succession, they still sort in the order they were made.
    const migrations = readdirSync(join(app, 'modules/billing/migrations')).sort();
    expect(migrations).toEqual([
      expect.stringMatching(/^\d{4}_\d\d_\d\d_\d{6}_create_invoices_table\.ts$/),
      expect.stringMatching(/^\d{4}_\d\d_\d\d_\d{6}_add_due_date_to_invoices_table\.ts$/),
      expect.stringMatching(/^\d{4}_\d\d_\d\d_\d{6}_backfill_totals\.ts$/),
    ]);
    expect(readFileSync(join(app, 'modules/billing/migrations', migrations[0]!), 'utf8')).toContain("schema.create('invoices', (table) => {");
    expect(readFileSync(join(app, 'modules/billing/migrations', migrations[1]!), 'utf8')).toContain("schema.alter('invoices', (table) => {");
    // A blank migration builds a plan, so it is not async and points at the step for data.
    const blank = readFileSync(join(app, 'modules/billing/migrations', migrations[2]!), 'utf8');
    expect(blank).toContain('up: (schema) => {');
    expect(blank).toContain('schema.data(async (db) => …)');
    expect(blank).not.toContain('async (schema)');

    const typecheck = spawnSync(tsc, ['-p', app], { encoding: 'utf8' });
    expect(typecheck.stdout + typecheck.stderr).toBe('');
    expect(typecheck.status).toBe(0);
  }, 30_000); // fifteen CLI processes — seconds under a full parallel run

  it('generates a mail that compiles, previews and renders in its layout, and never overwrites', async () => {
    const made = marmeon(app, ['make:mail', 'InvoiceOverdue', '--module=billing']);
    expect([made.code, made.stderr]).toEqual([0, '']);
    expect(made.stdout).toContain('Created modules/billing/mail/InvoiceOverdueMail.ts');
    expect(made.stdout).toContain('Created modules/billing/mail/layout.ts');
    expect(made.stdout).toContain('/_marmeon/mail/billing/InvoiceOverdueMail');
    // The layout stays for the next mail, and neither file is overwritten.
    const layoutBefore = readFileSync(join(app, 'modules/billing/mail/layout.ts'), 'utf8');
    writeFileSync(join(app, 'modules/billing/mail/layout.ts'), `${layoutBefore}// mine\n`);
    const second = marmeon(app, ['make:mail', 'PaymentFailed', '--module=billing']);
    expect([second.code, second.stdout]).toEqual([0, expect.not.stringContaining('Created modules/billing/mail/layout.ts')]);
    expect(readFileSync(join(app, 'modules/billing/mail/layout.ts'), 'utf8')).toContain('// mine');
    const again = marmeon(app, ['make:mail', 'InvoiceOverdue', '--module=billing']);
    expect([again.code, again.stderr]).toEqual([1, expect.stringContaining('already exists (use --force to overwrite)')]);
    const forced = marmeon(app, ['make:mail', 'PaymentFailed', '--module=billing', '--force']);
    expect(forced.code).toBe(0);
    expect(readFileSync(join(app, 'modules/billing/mail/layout.ts'), 'utf8')).toContain('// mine');
    writeFileSync(join(app, 'modules/billing/mail/layout.ts'), layoutBefore);

    const typecheck = spawnSync(tsc, ['-p', app], { encoding: 'utf8' });
    expect(typecheck.stdout + typecheck.stderr).toBe('');
    expect(typecheck.status).toBe(0);

    // The preview builds the mail from the container; the mail composes into the layout with the app's name, and MJML accepts it.
    const { InvoiceOverdueMail } = (await import(join(app, 'modules/billing/mail/InvoiceOverdueMail.ts'))) as { InvoiceOverdueMail: { preview(context: object): Promise<Mailable> | Mailable } };
    // The app's own copies of the packages, so the keys are the ones the generated files import.
    writeFileSync(join(app, 'modules/billing/packages.ts'), "export { Translators } from '@marmeon/i18n';\nexport { fromMjml } from '@marmeon/mail';\n");
    const { Translators, fromMjml } = (await import(join(app, 'modules/billing/packages.ts'))) as { Translators: unknown; fromMjml: (content: unknown) => Promise<{ html: string; text: string }> };
    const make = (key: unknown) => (key === Translators ? { for: (locale: string | undefined) => ({ locale: locale ?? 'en' }) } : undefined);
    const mail = await InvoiceOverdueMail.preview({ make, locale: 'de' });
    const envelope = await mail.envelope();
    expect(envelope).toEqual({ to: { address: 'ada@example.com', name: 'Ada Lovelace' }, subject: 'A message for you' });
    const { html, text } = await fromMjml(await mail.content());
    expect(html).toContain('<html lang="de"');
    expect(html).toContain('This is the text of InvoiceOverdueMail.');
    expect(text).toContain('This is the text of InvoiceOverdueMail.');
    rmSync(join(app, 'modules/billing/packages.ts'));
  }, 30_000);

  it('generates a mail that compiles against the starter kit\'s layout', () => {
    mkdirSync(join(app, 'modules/kitmail/mail'), { recursive: true });
    writeFileSync(join(app, 'modules/kitmail/index.ts'), "import { defineModule } from '@marmeon/core';\nexport default defineModule({ name: 'kitmail' });\n");
    // The kit's frame takes the translator, a preview and a body, and finds the app's name itself.
    // Its footer reads a message of the kit's own lang files, which this app does not have: a literal stands in.
    const kitLayout = readFileSync(join(repo, 'packages/auth/stubs/react/modules/auth/mail/layout.ts'), 'utf8').replace("t.get('auth.mail.app')", "'Shop'");
    writeFileSync(join(app, 'modules/kitmail/mail/layout.ts'), kitLayout);
    const made = marmeon(app, ['make:mail', 'Welcome', '--module=kitmail']);
    expect([made.code, made.stderr]).toEqual([0, '']);
    expect(made.stdout).not.toContain('Created modules/kitmail/mail/layout.ts');
    expect(readFileSync(join(app, 'modules/kitmail/mail/layout.ts'), 'utf8')).toBe(kitLayout);
    const typecheck = spawnSync(tsc, ['-p', app], { encoding: 'utf8' });
    expect(typecheck.stdout + typecheck.stderr).toBe('');
    expect(typecheck.status).toBe(0);
    rmSync(join(app, 'modules/kitmail'), { recursive: true });
  }, 30_000);

  it('generates a policy that lets the owner in and answers everyone else with a 404', async () => {
    // The Gate comes through the app's own resolution, so it is the module instance the policy's answers belong to.
    writeFileSync(join(app, 'modules/billing/gate.ts'), "export { Gate } from '@marmeon/auth';\n");
    const { Gate } = (await import(join(app, 'modules/billing/gate.ts'))) as { Gate: new (auth: never, resolve: (policy: new () => object) => object) => { inspect(policy: never, ability: never, record: never): Promise<{ allowed: boolean; status: number }> } };
    const { InvoicePolicy } = (await import(join(app, 'modules/billing/policies/InvoicePolicy.ts'))) as { InvoicePolicy: new () => object };
    const ask = (userId: number, ability: string, record: object) =>
      new Gate({ user: async () => ({ id: userId }) } as never, (policy) => new policy()).inspect(InvoicePolicy as never, ability as never, record as never);
    for (const ability of ['view', 'update', 'delete']) {
      expect((await ask(7, ability, { user_id: 7 })).allowed).toBe(true);
      const other = await ask(8, ability, { user_id: 7 });
      expect([other.allowed, other.status]).toEqual([false, 404]);
      const orphan = await ask(7, ability, {});
      expect([orphan.allowed, orphan.status]).toEqual([false, 404]);
    }
  });

  it('generates a test that compiles against the app and passes the lint preset', () => {
    mkdirSync(join(app, 'bootstrap'));
    writeFileSync(join(app, 'bootstrap/app.ts'), "import { defineApplication } from '@marmeon/core';\nexport default defineApplication({ root: import.meta.dirname + '/..' });\n");
    writeFileSync(join(app, '.gitignore'), 'node_modules\n'); // oxlint would walk pnpm's links without it
    expect(marmeon(app, ['make:test', 'send-invoice', '--module=billing', '--path=/billing/invoices/:id']).code).toBe(0);
    expect(marmeon(app, ['make:lint-config']).code).toBe(0);
    const file = join(app, 'modules/billing/send-invoice.test.ts');
    const oxlint = spawnSync(join(repo, 'node_modules/.bin/oxlint'), ['--deny-warnings', '-f', 'unix', file], { cwd: app, encoding: 'utf8' });
    expect([oxlint.status, oxlint.stdout]).toEqual([0, expect.not.stringContaining('[Error/')]);
    const typecheck = spawnSync(tsc, ['-p', app], { encoding: 'utf8' });
    expect(typecheck.stdout + typecheck.stderr).toBe('');
    expect(typecheck.status).toBe(0);
    rmSync(join(app, 'bootstrap'), { recursive: true });
    rmSync(join(app, '.oxlintrc.json'));
    rmSync(join(app, '.gitignore'));
    rmSync(file);
  }, 30_000);

  it('writes a module whose routes.ts passes the lint preset without a warning', () => {
    writeFileSync(join(app, '.gitignore'), 'node_modules\n'); // oxlint would walk pnpm's links without it
    expect(marmeon(app, ['make:module', 'lintprobe', '--no-register']).code).toBe(0);
    expect(marmeon(app, ['make:lint-config']).code).toBe(0);
    const oxlint = spawnSync(join(repo, 'node_modules/.bin/oxlint'), ['--deny-warnings', '-f', 'unix', 'modules/lintprobe'], { cwd: app, encoding: 'utf8' });
    expect([oxlint.status, oxlint.stdout]).toEqual([0, expect.not.stringContaining('routes.ts')]);
    rmSync(join(app, 'modules/lintprobe'), { recursive: true });
    rmSync(join(app, '.oxlintrc.json'));
    rmSync(join(app, '.gitignore'));
  }, 30_000);

  it('generates a complete resource that compiles, and a policy that lets the owner in and nobody else', async () => {
    const manifest = readFileSync(join(app, 'package.json'), 'utf8');
    const tsconfig = readFileSync(join(app, 'tsconfig.json'), 'utf8');
    try {
      // What the starter kit gives a resource: the auth module's exports and layout, the user's shape, and the tables (the web app's).
      mkdirSync(join(app, 'modules/auth/layouts'), { recursive: true });
      writeFileSync(
        join(app, 'modules/auth/index.ts'),
        [
          "import { defineFactory, Repository } from '@marmeon/database';",
          "export const UserFactory = defineFactory('users', ({ sequence }) => ({ name: `User ${sequence}`, email: `user${sequence}@example.com`, password: 'x', session_key: 'x' }));",
          "export class UserRepository extends Repository<'users'> {",
          "  static table = 'users' as const;",
          '  async deleteAccounts(ids: readonly number[]) { return ids; }',
          '}',
          '',
        ].join('\n'),
      );
      writeFileSync(join(app, 'modules/auth/layouts/AppLayout.tsx'), "import type { LayoutProps } from '@marmeon/react';\nexport const AppLayout = ({ children }: LayoutProps) => children;\n");
      // The verified() middleware reads the address of the user.
      writeFileSync(
        join(app, 'modules/billing/auth-types.ts'),
        "declare module '@marmeon/auth' { interface AuthTypes { user: { readonly id: number; readonly email: string; readonly email_verified_at: string | null } } }\nexport {};\n",
      );
      writeFileSync(join(app, 'modules/tables.d.ts'), readFileSync(join(webApp, 'bootstrap/database.d.ts'), 'utf8'));
      mkdirSync(join(app, 'bootstrap'));
      writeFileSync(join(app, 'bootstrap/app.ts'), "import { defineApplication } from '@marmeon/core';\nexport default defineApplication({ root: import.meta.dirname + '/..' });\n");
      const made = marmeon(app, ['make:resource', 'Bookmark']);
      expect([made.code, made.stderr]).toEqual([0, '']);
      expect(readFileSync(join(app, 'bootstrap/app.ts'), 'utf8')).toContain('modules: [bookmarks]');

      // The typed routes of the new module (`<Link route>`, `FormFieldsOf`) come from the route types of an app that has it.
      writeFileSync(join(app, 'package.json'), JSON.stringify({ ...JSON.parse(manifest), imports: { '#modules/*': './modules/*/index.ts' } }));
      const routeTypes = marmeon(app, ['route:types']);
      expect([routeTypes.code, routeTypes.stderr]).toEqual([0, '']);
      writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({ ...JSON.parse(tsconfig), include: ['modules', 'bootstrap'] }));

      const typecheck = spawnSync(tsc, ['-p', app], { encoding: 'utf8' });
      expect(typecheck.stdout + typecheck.stderr).toBe('');
      expect(typecheck.status).toBe(0);

      // The policy through the Gate: the owner passes, anyone else gets a 404.
      writeFileSync(join(app, 'modules/billing/gate.ts'), "export { Gate } from '@marmeon/auth';\n");
      const { Gate } = (await import(join(app, 'modules/billing/gate.ts'))) as { Gate: new (auth: never, resolve: (policy: new () => object) => object) => { inspect(policy: never, ability: never, record: never): Promise<{ allowed: boolean; status: number }> } };
      const { BookmarkPolicy } = (await import(join(app, 'modules/bookmarks/policies/BookmarkPolicy.ts'))) as { BookmarkPolicy: new () => object };
      const ask = (userId: number, ability: string, record: object) =>
        new Gate({ user: async () => ({ id: userId }) } as never, (policy) => new policy()).inspect(BookmarkPolicy as never, ability as never, record as never);
      for (const ability of ['view', 'update', 'delete']) {
        expect((await ask(7, ability, { user_id: 7 })).allowed).toBe(true);
        const other = await ask(8, ability, { user_id: 7 });
        expect([other.allowed, other.status]).toEqual([false, 404]);
      }
    } finally {
      writeFileSync(join(app, 'package.json'), manifest);
      writeFileSync(join(app, 'tsconfig.json'), tsconfig);
      for (const path of ['bootstrap', 'modules/auth', 'modules/bookmarks', 'modules/tables.d.ts', 'modules/billing/gate.ts', 'modules/billing/auth-types.ts']) {
        rmSync(join(app, path), { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('generates a repository, a factory and a table that compile against the module\'s table types, and a table that boots and loads', async () => {
    const manifest = readFileSync(join(app, 'package.json'), 'utf8');
    try {
      writeFileSync(join(app, 'package.json'), JSON.stringify({ ...JSON.parse(manifest), dependencies: { ...JSON.parse(manifest).dependencies, '@marmeon/database': 'workspace:*', '@marmeon/table': 'workspace:*' } }));
      writeFileSync(
        join(app, 'modules/billing/auth-types.ts'),
        "declare module '@marmeon/auth' { interface AuthTypes { user: { readonly id: number } } }\nexport {};\n",
      );
      // The shape `db:types` writes for a table with an id and timestamps.
      writeFileSync(
        join(app, 'modules/tables.d.ts'),
        [
          "import type { Generated, Timestamp } from '@marmeon/database';",
          "declare module '@marmeon/database' {",
          '  interface Tables {',
          '    invoices: { id: Generated<number>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp> };',
          '  }',
          "  interface PrimaryKeys { invoices: 'id' }",
          "  interface TableOwners { invoices: 'billing' }",
          '  interface ExposedTables {}',
          '  interface Modules { billing: true }',
          '}',
          '',
        ].join('\n'),
      );
      for (const [command, file] of [['make:repository', 'InvoiceRepository.ts'], ['make:factory', 'factories/InvoiceFactory.ts'], ['make:table', 'tables/InvoiceTable.ts']] as const) {
        const made = marmeon(app, [command, 'Invoice', '--module=billing']);
        expect([made.code, made.stderr]).toEqual([0, '']);
        expect(made.stdout).toContain(`Created modules/billing/${file}`);
      }
      // The table is shown by the page's routes; this registrar is the one a page of signed-in users has.
      writeFileSync(
        join(app, 'modules/billing/invoice-routes.ts'),
        [
          "import { authenticate } from '@marmeon/auth';",
          "import { defineRoutes, everyone } from '@marmeon/http';",
          "import { tableRoutes } from '@marmeon/table';",
          "import { InvoiceTable } from './tables/InvoiceTable.ts';",
          'export default defineRoutes((Route) => {',
          '  tableRoutes(Route.prefix(\'/invoices\').middleware(authenticate()).authorize(everyone), InvoiceTable);',
          '});',
          '',
        ].join('\n'),
      );
      writeFileSync(join(app, 'modules/billing/boot.ts'), "export { Router } from '@marmeon/router';\nexport { TableServiceProvider } from '@marmeon/table';\n");

      const typecheck = spawnSync(tsc, ['-p', app], { encoding: 'utf8' });
      expect(typecheck.stdout + typecheck.stderr).toBe('');
      expect(typecheck.status).toBe(0);

      // The table passes the check of a registrar that lets everyone call it (it has no action or export to leave open),
      // and the boot check of the table package.
      const { Router, TableServiceProvider } = (await import(join(app, 'modules/billing/boot.ts'))) as {
        Router: new () => { load(routes: unknown): unknown };
        TableServiceProvider: new () => { boot(app: unknown): void };
      };
      const routes = (await import(join(app, 'modules/billing/invoice-routes.ts'))) as { default: unknown };
      const router = new Router();
      expect(() => router.load(routes.default)).not.toThrow();
      expect(() => new TableServiceProvider().boot({ container: { make: () => router } })).not.toThrow();
      const table = (await import(join(app, 'modules/billing/tables/InvoiceTable.ts'))) as { InvoiceTable: { definition: { name: string; authorize: (() => boolean) | undefined } } };
      expect(table.InvoiceTable.definition.name).toBe('invoices');
      // Nobody sees the table until the app says who may.
      expect(table.InvoiceTable.definition.authorize?.()).toBe(false);
      const factory = (await import(join(app, 'modules/billing/factories/InvoiceFactory.ts'))) as { InvoiceFactory: { table: string } };
      expect(factory.InvoiceFactory.table).toBe('invoices');
    } finally {
      writeFileSync(join(app, 'package.json'), manifest);
      for (const path of ['modules/tables.d.ts', 'modules/billing/auth-types.ts', 'modules/billing/invoice-routes.ts', 'modules/billing/boot.ts', 'modules/billing/InvoiceRepository.ts', 'modules/billing/factories/InvoiceFactory.ts', 'modules/billing/tables']) {
        rmSync(join(app, path), { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('refuses to overwrite and explains missing modules', () => {
    marmeon(app, ['make:module', 'shop']);
    const again = marmeon(app, ['make:module', 'shop']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('modules/shop/index.ts already exists (use --force to overwrite)');

    const missing = marmeon(app, ['make:controller', 'ShowCart', '--module=cart']);
    expect(missing.stderr).toContain('Module "cart" does not exist. Create it first: marmeon make:module cart');
  });

  it('generates the application key into .env — without booting, never silently replacing one, rotating with --force', () => {
    writeFileSync(join(app, '.env.example'), 'APP_NAME=Shop\nAPP_KEY=\n');
    expect(marmeon(app, ['key:generate']).code).toBe(0);
    const env = readFileSync(join(app, '.env'), 'utf8');
    expect(env).toMatch(/^APP_NAME=Shop\nAPP_KEY=base64:[A-Za-z0-9+/]{43}=\n$/);

    const again = marmeon(app, ['key:generate']);
    expect(again.code).toBe(1);
    // What --force does: it keeps the old key for what it encrypted — the message must not say it breaks them.
    expect(again.stderr).toBe(
      '✗ APP_KEY is already set. --force replaces it and moves the old key to APP_PREVIOUS_KEYS, so sessions, encrypted cookies and signed links stay valid.\n',
    );
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe(env);

    // --force rotates: the old key moves to APP_PREVIOUS_KEYS — what it encrypted stays readable.
    const first = /^APP_KEY=(.*)$/m.exec(env)![1]!;
    const rotated = marmeon(app, ['key:generate', '--force']);
    expect(rotated.code).toBe(0);
    expect(rotated.stdout).toContain('The old key moved to APP_PREVIOUS_KEYS');
    const second = readFileSync(join(app, '.env'), 'utf8');
    expect(second).toMatch(new RegExp(`^APP_NAME=Shop\nAPP_KEY=base64:[A-Za-z0-9+/]{43}=\nAPP_PREVIOUS_KEYS=${first.replaceAll('+', '\\+')}\n$`));
    expect(/^APP_KEY=(.*)$/m.exec(second)![1]).not.toBe(first);
    // Again: the newest old key first, none twice.
    const secondKey = /^APP_KEY=(.*)$/m.exec(second)![1]!;
    expect(marmeon(app, ['key:generate', '--force']).code).toBe(0);
    expect(/^APP_PREVIOUS_KEYS=(.*)$/m.exec(readFileSync(join(app, '.env'), 'utf8'))![1]).toBe(`${secondKey},${first}`);
    expect(marmeon(app, ['key:generate', '--show']).stdout).toMatch(/^base64:[A-Za-z0-9+/]{43}=\n$/);
  });

  it.skipIf(process.platform === 'win32')('creates .env readable by its owner only, and tightens an existing one that others could read', () => {
    rmSync(join(app, '.env'), { force: true });
    writeFileSync(join(app, '.env.example'), 'APP_KEY=\n');
    chmodSync(join(app, '.env.example'), 0o644);
    const created = marmeon(app, ['key:generate']);
    expect(created.code).toBe(0);
    expect(created.stdout).not.toContain('readable by its owner only');
    expect(statSync(join(app, '.env')).mode & 0o777).toBe(0o600);

    chmodSync(join(app, '.env'), 0o644);
    const tightened = marmeon(app, ['key:generate', '--force']);
    expect(tightened.code).toBe(0);
    expect(tightened.stdout).toContain('Made .env readable by its owner only.');
    expect(statSync(join(app, '.env')).mode & 0o777).toBe(0o600);
  });

  it('runs generators without a bootable app (no bootstrap, no .env)', () => {
    expect(marmeon(app, ['make:event', 'CartEmptied', '--module=shop']).code).toBe(0);
    expect(marmeon(app, ['route:list']).stderr).toContain('No Marmeon app');
  });
});
