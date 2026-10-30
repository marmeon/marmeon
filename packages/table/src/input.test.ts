import { afterEach, describe, expect, it } from 'vitest';
import { drivers, inputFactories, tableApp, type TableTestApp, type TestDriver } from './__fixtures__/app.ts';
import { action, bulk } from './define.ts';

let open: TableTestApp | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function app(driver: TestDriver): Promise<TableTestApp> {
  open = await tableApp(driver);
  return open;
}

const ADA = 1;
const BASE = '/teams/1/input/_tables/input';

const post = (application: TableTestApp, path: string, json: unknown, user = ADA) => application.request(`${BASE}/${path}`, { method: 'POST', user, json, action: true });
const rolesOf = async (application: TableTestApp) =>
  Object.fromEntries((await application.connections.get().selectFrom('members').select(['id', 'role']).orderBy('id').execute()).map((row) => [row.id, row.role]));
const teamsOf = async (application: TableTestApp) =>
  Object.fromEntries((await application.connections.get().selectFrom('members').select(['id', 'team_id']).orderBy('id').execute()).map((row) => [row.id, row.team_id]));
const errorsOf = async (response: Response) => ((await response.json()) as { errors: Record<string, string[]> }).errors;

describe.each(drivers)('actions with input on %s', (driver) => {
  describe('a row action', () => {
    it('hands the handler the validated input along with the row', async () => {
      const application = await app(driver);
      const response = await post(application, 'actions/setRole', { key: 2, input: { role: 'admin' } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ done: 1, skipped: 0, missing: 0 });
      expect(application.recorder.inputs).toEqual([[[2], { role: 'admin' }]]);
      expect((await rolesOf(application))[2]).toBe('admin');
    });

    it('refuses a value the schema refuses: a 422 under input.<field>, the handler is not called', async () => {
      const application = await app(driver);
      const response = await post(application, 'actions/setRole', { key: 2, input: { role: 'owner' } });
      expect(response.status).toBe(422);
      expect(Object.keys(await errorsOf(response))).toEqual(['input.role']);
      expect(application.recorder.inputs, 'the handler ran with an input the schema refuses').toEqual([]);
      expect((await rolesOf(application))[2]).toBe('member');
    });

    it('refuses a missing input (a 422 under input) — also when the key is no row, so the input is checked first', async () => {
      const application = await app(driver);
      expect(Object.keys(await errorsOf(await post(application, 'actions/setRole', { key: 2 })))).toEqual(['input']);
      expect((await post(application, 'actions/setRole', { key: 777 })).status).toBe(422);
      expect(application.recorder.inputs).toEqual([]);
    });

    it('refuses input for an action that takes none — a field that does nothing is never mistaken for one that is checked', async () => {
      const application = await app(driver);
      const response = await post(application, 'actions/deactivate', { key: 2, input: { role: 'admin' } });
      expect(response.status).toBe(422);
      expect(await errorsOf(response)).toEqual({ input: ['This action takes no input.'] });
      expect(application.recorder.deactivated).toEqual([]);
      expect((await post(application, 'actions/deactivate', { key: 2 })).status).toBe(200);
    });

    it('still looks the row up in the base query: another team\'s row is a 404 with valid input', async () => {
      const application = await app(driver);
      expect((await post(application, 'actions/setRole', { key: 9, input: { role: 'member' } })).status).toBe(404);
      expect((await rolesOf(application))[9]).toBe('admin');
    });
  });

  describe('a bulk action', () => {
    it('hands the handler the validated input along with the chosen rows', async () => {
      const application = await app(driver);
      const response = await post(application, 'bulk/setRole', { keys: [2, 3], input: { role: 'admin' } });
      expect(await response.json()).toEqual({ done: 2, skipped: 0, missing: 0 });
      expect(application.recorder.inputs).toEqual([[[2, 3], { role: 'admin' }]]);
      expect(await rolesOf(application)).toEqual({ 1: 'admin', 2: 'admin', 3: 'admin', 4: 'member', 9: 'admin' });
    });

    it('takes the input for "all matching" too — the table\'s state parsed again, the input checked', async () => {
      const application = await app(driver);
      const response = await post(application, 'bulk/setRole', { all: true, query: {}, input: { role: 'admin' } });
      expect(await response.json()).toEqual({ done: 4, skipped: 0, missing: 0 });
      expect(application.recorder.inputs).toEqual([[[1, 2, 4, 3], { role: 'admin' }]]);
      const refused = await post(application, 'bulk/setRole', { all: true, query: {}, input: { role: 'owner' } });
      expect(refused.status).toBe(422);
      expect(Object.keys(await errorsOf(refused))).toEqual(['input.role']);
      expect(application.recorder.inputs).toHaveLength(1);
    });

    it('refuses a wrong value before any row is read or written', async () => {
      const application = await app(driver);
      application.queries.length = 0;
      const response = await post(application, 'bulk/setRole', { keys: [2, 3], input: { role: 'owner' } });
      expect(response.status).toBe(422);
      expect(application.queries.filter((query) => /\bmembers\b/.test(query.sql)), 'a row was read for input the schema refuses').toEqual([]);
      expect(await rolesOf(application)).toEqual({ 1: 'admin', 2: 'member', 3: 'member', 4: 'member', 9: 'admin' });
    });

    it('leaves keys of other teams out and counts them as missing — with the input valid', async () => {
      const application = await app(driver);
      const response = await post(application, 'bulk/setRole', { keys: [2, 9], input: { role: 'admin' } });
      expect(await response.json()).toEqual({ done: 1, skipped: 0, missing: 1 });
      expect(application.recorder.inputs).toEqual([[[2], { role: 'admin' }]]);
      expect((await rolesOf(application))[9]).toBe('admin');
    });

    it('builds the schema per request: a team of another request is a 422 and nothing is written (exists with a where on the request)', async () => {
      const application = await app(driver);
      const foreign = await post(application, 'bulk/moveToTeam', { keys: [2, 3], input: { team: 2 } });
      expect(foreign.status).toBe(422);
      expect(Object.keys(await errorsOf(foreign))).toEqual(['input.team']);
      const unknown = await post(application, 'bulk/moveToTeam', { keys: [2], input: { team: 777 } });
      expect(unknown.status).toBe(422);
      expect(application.recorder.inputs, 'the handler ran with a team the request has no right to').toEqual([]);
      expect(await teamsOf(application)).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 9: 2 });
      const own = await post(application, 'bulk/moveToTeam', { keys: [2], input: { team: 1 } });
      expect(own.status).toBe(200);
      expect(application.recorder.inputs).toEqual([[[2], { team: 1 }]]);
    });

    it('refuses input for a bulk action that takes none', async () => {
      const application = await app(driver);
      const response = await post(application, 'bulk/deactivate', { keys: [2], input: { role: 'admin' } });
      expect(response.status).toBe(422);
      expect(await errorsOf(response)).toEqual({ input: ['This action takes no input.'] });
      expect(application.recorder.batches).toEqual([]);
    });
  });

  describe('a form posted without JavaScript', () => {
    const back = { accept: 'text/html', referer: 'http://localhost/teams/1/members' };

    it('sends the input as input[field]=… — it arrives as an object, row or bulk, "all matching" too', async () => {
      const application = await app(driver);
      const row = await application.request(`${BASE}/actions/setRole`, { method: 'POST', user: ADA, form: 'key=2&input[role]=admin', headers: back });
      expect(row.status).toBe(303);
      const many = await application.request(`${BASE}/bulk/setRole`, { method: 'POST', user: ADA, form: 'keys[]=3&keys[]=4&input[role]=admin', headers: back });
      expect(many.status).toBe(303);
      const all = await application.request(`${BASE}/bulk/setRole?sort=-name`, { method: 'POST', user: ADA, form: 'all=1&input[role]=member', headers: back });
      expect(all.status).toBe(303);
      expect(application.recorder.inputs).toEqual([
        [[2], { role: 'admin' }],
        [[3, 4], { role: 'admin' }],
        [[3, 4, 2, 1], { role: 'member' }],
      ]);
    });
  });

  describe('the checks come first: input is validated only for a request that was let on', () => {
    const ALAN = 2;
    const EDSGER = 4; // refused by the table's authorize

    for (const [who, user] of [['a refused table authorize', EDSGER], ['a hidden action', ALAN]] as const) {
      it(`${who}: invalid input is a 403, the schema is never built and no query runs — row and bulk`, async () => {
        const application = await app(driver);
        inputFactories.calls = 0;
        application.queries.length = 0;
        const row = await post(application, 'actions/hiddenRole', { key: 2, input: { role: 'owner' } }, user);
        const many = await post(application, 'bulk/hiddenMove', { keys: [2], input: { team: 777 } }, user);
        expect([row.status, many.status]).toEqual([403, 403]);
        if (user === EDSGER) expect((await post(application, 'bulk/moveToTeam', { keys: [2], input: { team: 777 } }, user)).status).toBe(403);
        expect(inputFactories.calls, 'a schema was built for a request that was refused').toBe(0);
        expect(application.queries, 'a query ran for a request that was refused').toEqual([]);
        expect(application.recorder.inputs).toEqual([]);
      });
    }
  });

  describe('a definition', () => {
    it('is immutable: .input() gives a new action and leaves the first without one', () => {
      class Handler {
        handle() {}
      }
      const plain = action(Handler);
      const withInput = plain.input({ '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) } });
      expect(plain.inputSource).toBeUndefined();
      expect(withInput.inputSource).toBeDefined();
      expect(bulk(Handler).input(() => withInput.inputSource as never).inputSource).toBeTypeOf('function');
    });

    it('refuses something that is neither a schema nor a function that builds one', () => {
      class Handler {
        handle() {}
      }
      expect(() => action(Handler).input({} as never)).toThrow(TypeError);
      expect(() => bulk(Handler).input(undefined as never)).toThrow(TypeError);
    });
  });
});
