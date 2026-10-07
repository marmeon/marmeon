import { readFileSync } from 'node:fs';
import { ErrorSolutions, Redactor } from '@marmeon/core';
import { Router } from '@marmeon/router';
import { createTestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { ERROR_KINDS, type ErrorKind } from './controllers/ShowLabPageController.ts';

const page = { headers: { accept: 'text/html' } };
/**
 * Under `pnpm test:pgsql` a test runs in one transaction, which Postgres aborts with the failed statement — so the
 * missing-table solution cannot ask for the pending migrations there (a request outside a test can).
 */
const postgres = process.env.DB_CONNECTION === 'pgsql';

/** What the development error page says for each kind of `/lab/errors/:kind` — its solution's title (E130). */
const SOLUTIONS: Record<Exclude<ErrorKind, 'view' | 'optional-parameter'>, string> = {
  'container-unbound': 'Bind PaymentGateway in a service provider',
  'container-scoped': 'Resolve SharedData inside a scope',
  'container-no-list': 'Inject a class or a token',
  'container-circular': 'Break the circular dependency',
  'injection-import-type': 'Import the token as a value',
  config: 'Set PAYMENTS_API_URL in .env',
  'app-key': 'Generate an application key',
  route: 'Did you mean &quot;user-profile.show&quot;?',
  table: postgres ? 'Run the migrations' : 'Create the table &quot;payments&quot; in a migration',
};

describe('the lab’s errors on the development error page (E119, E130)', () => {
  for (const [kind, title] of Object.entries(SOLUTIONS)) {
    it(`${kind}: ${ERROR_KINDS[kind as ErrorKind]} — with its solution`, async () => {
      const app = await createTestApp(application, { env: { LAB_PAGES: 'true' }, database: 'refresh', debug: true });
      const response = await app.get(`/lab/errors/${kind}`, page).assertStatus(500);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.body).toContain('<article class="solution">');
      expect(response.body).toContain(`<h2>${title}</h2>`);
    });
  }

  it.skipIf(postgres)('a missing table: the solution says which migrations have not run', async () => {
    const app = await createTestApp(application, { env: { LAB_PAGES: 'true' }, database: 'refresh', debug: true });
    // The migrations table forgets the last one: as if it had not run.
    const db = app.container.make((await import('@marmeon/database')).Database);
    const last = await db.selectFrom('migrations' as never).select('name' as never).orderBy('id' as never, 'desc').executeTakeFirstOrThrow();
    await db.deleteFrom('migrations' as never).where('name' as never, '=', (last as { name: string }).name as never).execute();
    const response = await app.get('/lab/errors/table', page).assertStatus(500);
    expect(response.body).toContain('<h2>Run the 1 pending migration</h2>');
    expect(response.body).toContain((last as { name: string }).name);
    expect(response.body).toContain('marmeon migrate');
  });

  it('a defaulted parameter of an injectable type: built with its default, the warning on the page (E128)', async () => {
    const app = await createTestApp(application, { env: { LAB_PAGES: 'true' }, database: 'refresh', debug: true });
    const response = await app.get('/lab/errors/optional-parameter', page).assertStatus(500);
    const line = readFileSync(new URL('./errors.ts', import.meta.url), 'utf8').split('\n').findIndex((text) => text.includes('constructor(clock: Clock = new SystemClock())')) + 1;
    expect(response.body).toContain('<h2>Injection warnings</h2>');
    expect(response.body).toContain(
      `ReminderSchedule (${application.root}/modules/lab/errors.ts:${line}): the parameter &quot;clock: Clock = new SystemClock()&quot; is defaulted, so the container never injects Clock`,
    );
  });

  it('a missing view (R2) has its solution too — server rendering shows it in Vite’s overlay', async () => {
    const app = await createTestApp(application, { env: { LAB_PAGES: 'true' }, database: 'refresh', debug: true });
    const [solution] = await app.container.make(ErrorSolutions).find(new Error('[marmeon:R2] Page [lab/Missing] not found. Expected a default export in modules/lab/views/Missing.tsx'), {
      app: app.application,
    });
    expect(solution).toMatchObject({ title: 'Create modules/lab/views/Missing.tsx', command: 'marmeon route:types' });
  });

  it('the session cookie’s name is redacted like any credential (E125)', async () => {
    const app = await createTestApp(application, { env: { LAB_PAGES: 'true' }, database: 'refresh', debug: true });
    expect(app.container.make(Redactor).isSensitive('marmeon_session')).toBe(true);
    const response = await app.get('/lab/errors/container-unbound', { headers: { accept: 'text/html', cookie: 'marmeon_session=0123456789abcdef; lang=de' } }).assertStatus(500);
    expect(response.body).not.toContain('0123456789abcdef');
  });

  it('without debug — as in production and tests — the plain error page, no solution, no stack', async () => {
    const app = await createTestApp(application, { env: { LAB_PAGES: 'true' }, database: 'refresh' });
    const response = await app.navigating().get('/lab/errors/container-unbound').assertStatus(500);
    expect(response.page()?.props).toMatchObject({ status: 500, title: 'Server Error', message: 'Server Error', exception: null });
    expect(response.body).not.toMatch(/PaymentGateway|solution|ShowLabPageController/);
  });
});

describe('solutions are text, never actions (E130, CVE-2021-3129)', () => {
  it('no framework route under /_marmeon takes a POST — nothing there runs a solution', async () => {
    const app = await createTestApp(application, { env: { LAB_PAGES: 'true' }, database: 'refresh', debug: true });
    const internal = app.container.make(Router).routes.filter((route) => route.path.startsWith('/_marmeon'));
    expect(internal.length).toBeGreaterThan(0);
    expect(internal.filter((route) => route.methods.includes('POST'))).toEqual([]);
    expect(internal.filter((route) => /solution/i.test(route.path))).toEqual([]);
  });
});
