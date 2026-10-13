import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { twoFactorCode } from '@marmeon/auth';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';

const MODULES = join(import.meta.dirname, '..');

/** Every view of every module, with its path relative to the modules directory. */
function views(): { file: string; source: string }[] {
  return readdirSync(MODULES, { recursive: true, encoding: 'utf8' })
    .filter((file) => /(^|\/)views\/.+\.tsx$/.test(file))
    .map((file) => ({ file, source: readFileSync(join(MODULES, file), 'utf8') }));
}

// A named field that carries a secret: the browser sends it, so in a form without `method="post"` it travels in the URL of a GET.
const SECRET_FIELD = /name="(?:password|code|recovery_code)"/;

/** The opening tags of the forms in a rendered page (attribute order is the renderer's business). */
const formTags = (html: string) => html.match(/<form\b[^>]*>/g) ?? [];

describe('forms that carry secrets', () => {
  it('post — Enter before hydration (or after a failed chunk) must not become a GET with the password in the URL', () => {
    const offenders = views().flatMap(({ file, source }) =>
      [...source.matchAll(/<form\b[\s\S]*?<\/form>/g)]
        .filter(([form]) => SECRET_FIELD.test(form))
        .filter(([form]) => !/^<form\b[^>]*\bmethod="post"/.test(form))
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });

  it('looks at the views it is meant to check', () => {
    expect(views().map(({ file }) => file)).toContain('auth/views/TwoFactor.tsx');
  });
});

describe('the two-factor settings page, rendered on the server', { timeout: 30_000 }, () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp(application, { database: 'refresh', ssr: true });
  }, 30_000);

  it('posts both forms to their routes without JavaScript', async () => {
    const ada = await app.factory(UserFactory).create();
    const login = await app.post('/login', { form: { email: ada.email, password: 'password' } }).assertRedirect('/users/me');
    const session = app.withCookie('marmeon_session', login.cookie('marmeon_session')!);
    const html = { headers: { accept: 'text/html' } };

    await session.post('/settings/two-factor/setup').assertRedirect('/settings/two-factor');
    const setup = await session.get('/settings/two-factor', html).assertServerRendered();
    expect(formTags(setup.body).some((tag) => tag.includes('method="post"') && tag.includes('action="/settings/two-factor/confirm"'))).toBe(true);

    const secret = /<code>([A-Z2-7]+)<\/code>/.exec(setup.body)![1]!;
    await session.post('/settings/two-factor/confirm', { form: { code: twoFactorCode(secret), password: 'password' } }).assertOk();
    const enabled = await session.get('/settings/two-factor', html).assertServerRendered();
    expect(formTags(enabled.body).some((tag) => tag.includes('method="post"') && tag.includes('action="/settings/two-factor/disable"'))).toBe(true);
  });
});
