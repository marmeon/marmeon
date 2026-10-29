import { UserFactory, UserRepository, type User } from '#modules/auth';
import { Connections, type QueryEvent } from '@marmeon/database';
import type { TableData } from '@marmeon/table';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { warmUp, WARM_UP_TIMEOUT } from '../auth/warm-up.ts';
import { ProfileLinkFactory } from '../user-profile/factories/ProfileLinkFactory.ts';
import type { ListMembersController } from './controllers/ListMembersController.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
let ada: User, alan: User, grace: User;

/** The seeded people, in order: Ada (an administrator), Alan, Grace. */
async function people(): Promise<[User, User, User]> {
  const [first, second, third] = (await app.make(UserRepository).query().selectAll().orderBy('id').execute()) as User[];
  return [first!, second!, third!];
}
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  [ada, alan, grace] = await people();
  // The seeder gives Ada two links; Alan and Grace get one each.
  for (const user of [alan, grace]) await app.factory(ProfileLinkFactory).create({ user_id: user.id, label: `${user.name}'s site` });
});

type Members = TableData<{ id: number; name: string; email?: string; joined: string; links: number }>;

/** The members prop of `/members` as `user` gets it. */
async function members(user: User, query = ''): Promise<Members> {
  const response = await app.actingAs(user).navigating().get(`/members${query ? `?${query}` : ''}`).assertOk();
  return response.page()!.props.members as Members;
}

const localeOf = async (user: User) => (await app.make(UserRepository).find(user.id))?.locale ?? null;

const linksOf = async (user: User) => (await app.make(Connections).get().selectFrom('profile_links').select('id').where('user_id', '=', user.id).execute()).length;

describe('the members table (/members) — @marmeon/table in the app', () => {
  it('shows the e-mail column to administrators only (DASHBOARD_ADMINS): for everyone else it is not selected at all', async () => {
    const asAda = await members(ada);
    expect(asAda.columns.map((column) => column.name)).toEqual(['name', 'email', 'joined', 'links']);
    expect(asAda.rows.map((row) => row.email)).toEqual(['ada@example.com', 'alan@example.com', 'grace@example.com']);

    const queries: QueryEvent[] = [];
    const stop = app.make(Connections).onQuery((query) => void queries.push(query));
    const asAlan = await members(alan);
    stop();
    expect(asAlan.columns.map((column) => column.name)).toEqual(['name', 'joined', 'links']);
    expect(JSON.stringify(asAlan)).not.toContain('@example.com');
    // Not in the SQL either (the projection) — only the table's queries count: the session and auth read users too.
    const table = queries.filter((query) => query.sql.includes('"profile_links"'));
    expect(table.length).toBeGreaterThan(0);
    for (const query of table) expect(query.sql, 'the SQL selects a hidden column').not.toContain('"users"."email" as');
    // The control: an administrator's query does select it.
    queries.length = 0;
    const again = app.make(Connections).onQuery((query) => void queries.push(query));
    await members(ada);
    again();
    expect(queries.some((query) => query.sql.includes('"users"."email" as "email"'))).toBe(true);
  });

  it('lists members only — an unconfirmed account is none (the base query): not shown, not acted on', async () => {
    const pending = (await app.factory(UserFactory).create({ name: 'Pending Person', email_verified_at: null }))!;
    expect((await members(ada)).rows.map((row) => row.name)).not.toContain('Pending Person');
    const answer = await app.actingAs(ada).acting().post('/members/_tables/members/bulk/removeLinks', { json: { keys: [pending.id] } }).assertOk();
    expect(answer.json()).toEqual({ done: 0, skipped: 0, missing: 1 });
  });

  it('a guest never reaches the page or the table\'s endpoints — the page\'s middleware runs for them (401, the login)', async () => {
    await app.get('/members', { headers: { accept: 'text/html' } }).assertRedirect('/login');
    const action = await app.acting().post('/members/_tables/members/actions/removeLinks', { json: { key: alan.id } });
    expect(action.status, 'a guest was not sent to sign in by the action').toBe(401);
    const guestExport = await app.get('/members/_tables/members/export/csv', { headers: { accept: 'text/html' } });
    expect(guestExport.status, 'a guest was not sent to sign in by the export').toBe(302);
    expect(await linksOf(alan)).toBeGreaterThan(0);
  });

  it('an unconfirmed account never reaches the table\'s endpoints — verified() of the page\'s registrar runs for them too', async () => {
    // An administrator by address (DASHBOARD_ADMINS) who has not confirmed it: every policy of the table would say yes — only
    // verified() of the page's registrar stands in the way.
    await app.close();
    app = await createTestApp(application, { database: 'refresh', seed: true, env: { DASHBOARD_ADMINS: 'ada@example.com,pending.admin@example.com' } });
    [ada, alan, grace] = await people();
    await app.factory(ProfileLinkFactory).create({ user_id: alan.id, label: 'Site' });
    const unconfirmed = (await app.factory(UserFactory).create({ email: 'pending.admin@example.com', email_verified_at: null }))!;
    const row = await app.actingAs(unconfirmed).acting().post('/members/_tables/members/actions/removeLinks', { json: { key: alan.id } });
    expect(row.status, 'an unconfirmed account ran a table action').toBe(403);
    const many = await app.actingAs(unconfirmed).acting().post('/members/_tables/members/bulk/removeLinks', { json: { all: true, query: {} } });
    expect(many.status, 'an unconfirmed account ran a bulk action').toBe(403);
    const download = await app.actingAs(unconfirmed).get('/members/_tables/members/export/csv');
    expect(download.status, 'an unconfirmed account downloaded the export').not.toBe(200);
    expect(await linksOf(alan)).toBeGreaterThan(0);
  });

  it('sorts and filters by the URL — strictly: an unknown sort, a raw column, a page size that is none is a 400', async () => {
    expect((await members(ada, 'sort=-name')).rows.map((row) => row.name)).toEqual(['Grace Hopper', 'Alan Turing', 'Ada Lovelace']);
    // By the number of links the base query counts (withCount): ties broken by the key, in the same direction.
    expect((await members(ada, 'sort=-links')).rows.map((row) => [row.name, row.links])).toEqual([
      ['Ada Lovelace', 2],
      ['Grace Hopper', 1],
      ['Alan Turing', 1],
    ]);
    expect((await members(ada, 'search=tur')).rows.map((row) => row.name)).toEqual(['Alan Turing']);
    expect((await members(alan, 'search=grace@')).rows).toEqual([]); // the hidden column is not searched
    for (const query of ['sort=password', 'sort=created_at', 'sort=unknown', 'per_page=10000', 'filter[password]=x', 'filter[locale]=fr']) {
      const { status } = await app.actingAs(ada).navigating().get(`/members?${query}`);
      expect(status, `${query} answered ${status}`).toBe(400);
    }
    await app.actingAs(alan).navigating().get('/members?sort=email').assertStatus(400);
    const page = (await app.actingAs(ada).navigating().get('/members?sort=-joined').assertOk()).page()!;
    expect(page.query).toEqual({ sort: '-joined' });
    expect(page.queryDefaults).toEqual({ sort: 'name', page: 1, per_page: 10, search: '' });
  });

  it('filters by a relation with options per request: members who link to what the viewer links to — another member\'s label is a 400', async () => {
    // Ada has two links, Alan and Grace one each (their own labels): the viewer's labels are the only options.
    const asAda = await members(ada);
    const link = asAda.filters.find((entry) => entry.name === 'link')!;
    expect(link.type).toBe('has');
    const labels = link.type === 'dateRange' ? [] : link.options;
    expect(labels.length).toBeGreaterThan(0);
    expect((await members(ada, `filter[link]=${encodeURIComponent(labels[0]!)}`)).rows.map((row) => row.name)).toEqual(['Ada Lovelace']);
    const foreign = `filter[link]=${encodeURIComponent(`${alan.name}'s site`)}`;
    await app.actingAs(ada).navigating().get(`/members?${foreign}`).assertStatus(400);
    // The same label is an option for Alan, who has it.
    expect((await members(alan, foreign)).rows.map((row) => row.name)).toEqual(['Alan Turing']);
    await app.actingAs(ada).acting().post('/members/_tables/members/bulk/removeLinks', { json: { all: true, query: { 'filter[link]': `${alan.name}'s site` } } }).assertStatus(400);
    expect(await linksOf(alan)).toBe(1);
    await app.actingAs(ada).get(`/members/_tables/members/export/csv?${foreign}`).assertStatus(400);
  });

  it('removes a member\'s links (a row action): the policy again on the server — not your own, not as a member', async () => {
    const asAda = await members(ada);
    expect(asAda.rows.map((row) => [row.name, row.can.removeLinks])).toEqual([
      ['Ada Lovelace', false],
      ['Alan Turing', true],
      ['Grace Hopper', true],
    ]);
    expect(asAda.actions).toEqual([{ name: 'removeLinks', url: '/members/_tables/members/actions/removeLinks', confirm: true }]);
    expect(await linksOf(alan)).toBeGreaterThan(0);
    const answer = await app.actingAs(ada).acting().post('/members/_tables/members/actions/removeLinks', { json: { key: alan.id } }).assertOk().assertHeader('cache-control', 'no-store');
    expect(answer.json()).toMatchObject({ done: 1, skipped: 0, missing: 0 });
    expect(await linksOf(alan)).toBe(0);
    await app.actingAs(ada).acting().post('/members/_tables/members/actions/removeLinks', { json: { key: ada.id } }).assertForbidden();
    // A member sees no actions — and the endpoint refuses them as well.
    expect((await members(alan)).actions).toEqual([]);
    await app.actingAs(alan).acting().post('/members/_tables/members/actions/removeLinks', { json: { key: grace.id } }).assertForbidden();
    expect(await linksOf(ada)).toBeGreaterThan(0);
  });

  it('removes the links of many (bulk): chosen keys ∩ members ∩ the policy — refused ones counted, "all matching" by the filter state', async () => {
    const answer = await app.actingAs(ada).acting().post('/members/_tables/members/bulk/removeLinks', { json: { keys: [ada.id, alan.id, 99999] } }).assertOk();
    expect(answer.json()).toMatchObject({ done: 1, skipped: 1, missing: 1 });
    expect(await linksOf(alan)).toBe(0);
    expect(await linksOf(ada)).toBeGreaterThan(0);
    const all = await app.actingAs(ada).acting().post('/members/_tables/members/bulk/removeLinks', { json: { all: true, query: { search: 'grace' } } }).assertOk();
    expect(all.json()).toMatchObject({ done: 1, skipped: 0, missing: 0 });
    expect(await linksOf(grace)).toBe(0);
    await app.actingAs(ada).acting().post('/members/_tables/members/bulk/removeLinks', { json: { all: true, query: { sort: 'password' } } }).assertStatus(400);
  });

  it('sets the language of many (a bulk action with input): the value is checked before any member is read — nothing changes on a 422', async () => {
    const asAda = await members(ada);
    expect(asAda.bulk.map((entry) => entry.name)).toEqual(['removeLinks', 'setLocale']);
    const set = (user: User, json: unknown) => app.actingAs(user).acting().post('/members/_tables/members/bulk/setLocale', { json });
    const answer = await set(ada, { keys: [ada.id, alan.id, grace.id], input: { locale: 'de' } }).assertOk();
    expect(answer.json()).toMatchObject({ done: 2, skipped: 1, missing: 0, data: { updated: 2 } }); // not your own
    expect([await localeOf(alan), await localeOf(grace)]).toEqual(['de', 'de']);
    const refused = await set(ada, { keys: [alan.id], input: { locale: 'fr' } }).assertStatus(422);
    expect(Object.keys((refused.json() as { errors: object }).errors)).toEqual(['input.locale']);
    await set(ada, { keys: [alan.id] }).assertStatus(422);
    await set(ada, { all: true, query: {}, input: { locale: 'xx' } }).assertStatus(422);
    expect(await localeOf(alan)).toBe('de');
    const all = await set(ada, { all: true, query: { search: 'grace' }, input: { locale: 'en' } }).assertOk();
    expect(all.json()).toMatchObject({ done: 1 });
    expect([await localeOf(alan), await localeOf(grace)]).toEqual(['de', 'en']);
    await app.actingAs(alan).acting().post('/members/_tables/members/bulk/setLocale', { json: { keys: [grace.id], input: { locale: 'de' } } }).assertForbidden();
    expect(await localeOf(grace)).toBe('en');
    // The checks come first: a member is refused (403) before the input is looked at — a wrong value is no 422 for them.
    await set(alan, { keys: [grace.id], input: { locale: 'fr' } }).assertForbidden();
  });

  it('a form posted without JavaScript: a wrong value goes back (303) with the error flashed under input.locale, and nothing changes', async () => {
    const form = { 'keys[]': String(alan.id), 'input[locale]': 'fr' };
    const back = { accept: 'text/html', referer: 'http://localhost/members' };
    const refused = await app.actingAs(ada).withHeaders(back).post('/members/_tables/members/bulk/setLocale', { form }).assertRedirect('/members');
    refused.assertInvalid(['input.locale']);
    expect(await localeOf(alan)).not.toBe('fr');
    await app.actingAs(ada).withHeaders(back).post('/members/_tables/members/bulk/setLocale', { form: { ...form, 'input[locale]': 'de' } }).assertRedirect('/members').assertValid();
    expect(await localeOf(alan)).toBe('de');
  });

  it('downloads the list as CSV — administrators only, the visible columns, formulas escaped, no-store', async () => {
    await app.make(UserRepository).update(grace.id, { name: '=HYPERLINK("https://evil.example","Grace")' });
    const response = await app.actingAs(ada).get('/members/_tables/members/export/csv?sort=-joined').assertOk();
    response.assertHeader('cache-control', 'no-store');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="members-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = response.body.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('"name","email","joined","links"');
    expect(lines[1], 'a formula reached the CSV').toMatch(/^"'=HYPERLINK\(""https:\/\/evil\.example"",""Grace""\)","grace@example\.com",/);
    expect(lines).toHaveLength(5);
    await app.actingAs(alan).get('/members/_tables/members/export/csv').assertForbidden();
    expect((await members(alan)).exports).toEqual([]);
  });

  it('renders accessible markup: a caption, aria-sort on the sorted heading only, named checkboxes and buttons, a live region', async () => {
    // Rendered on the server (through the app's Vite setup) — and it hydrates to the same markup.
    await app.close();
    app = await createTestApp(application, { database: 'refresh', seed: true, ssr: true });
    [ada, alan, grace] = await people();
    for (const user of [alan, grace]) await app.factory(ProfileLinkFactory).create({ user_id: user.id, label: 'Site' });
    const html = (await app.actingAs(ada).get('/members?sort=-joined', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered().assertHydrates()).body;
    expect(html).toContain('<caption>');
    expect(html.match(/aria-sort=/g), 'aria-sort on a heading the table is not sorted by').toHaveLength(1);
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Select Alan Turing"');
    // The button's name starts with its visible text (WCAG 2.5.3) — the member's name heads the row.
    expect(html).toContain('aria-label="Remove links: Alan Turing"');
    expect(html).toContain('<th scope="row">Alan Turing</th>');
    expect(html).not.toContain('role="grid"');
    // A member's page: no e-mail anywhere in the table, no actions, no export.
    const asAlan = (await app.actingAs(alan).get('/members', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered()).body;
    expect(asAlan).not.toContain('grace@example.com');
    expect(asAlan).not.toContain('data-export');
  });

  it('CSRF holds for the table\'s POSTs (the page\'s `web` group): another site is refused', async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh', seed: true, csrf: true });
    const [admin, member] = await people();
    await app.factory(ProfileLinkFactory).create({ user_id: member.id, label: 'Site' });
    await app.actingAs(admin).withHeaders({ 'sec-fetch-site': 'cross-site' }).acting().post('/members/_tables/members/actions/removeLinks', { json: { key: member.id } }).assertForbidden();
    expect(await linksOf(member)).toBeGreaterThan(0);
    await app.actingAs(admin).withHeaders({ 'sec-fetch-site': 'same-origin' }).acting().post('/members/_tables/members/actions/removeLinks', { json: { key: member.id } }).assertOk();
    expect(await linksOf(member)).toBe(0);
  });

  it('throttles the table\'s endpoints (60 a minute per user) — an export reads the whole filtered table', async () => {
    for (let request = 1; request <= 60; request++) await app.actingAs(ada).get('/members/_tables/members/export/csv').assertOk();
    const over = await app.actingAs(ada).get('/members/_tables/members/export/csv');
    expect(over.status, 'the 61st request of a minute was served').toBe(429);
  });

  it('pages: ten to a page, the sizes the table offers', async () => {
    await app.factory(UserFactory).count(12).create();
    const first = await members(ada);
    expect(first.page).toMatchObject({ type: 'offset', page: 1, perPage: 10, total: 15, lastPage: 2 });
    expect((await members(ada, 'page=2&per_page=10')).rows).toHaveLength(5);
    expect((await members(ada, 'per_page=25')).rows).toHaveLength(15);
  });
});

export type { ListMembersController };
