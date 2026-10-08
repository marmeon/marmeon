import type { StandardSchemaV1 } from '@marmeon/core';
import { defineRequest, defineRoutes, Router, translatable, VALIDATE_HEADER, ValidationError, type ContextOf, type HttpContext, type MessageTranslator, type Next } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { rules as r } from './index.ts';

// ——— A repository as @marmeon/database's are: query() and withTrashed() give a Kysely-like builder ———

interface UserRow {
  id: number;
  email: string;
  team: number;
  deleted: boolean;
}

class FakeQuery {
  readonly #rows: readonly UserRow[];
  readonly #where: [keyof UserRow, string, unknown][] = [];
  readonly #log: string[];

  constructor(rows: readonly UserRow[], log: string[]) {
    this.#rows = rows;
    this.#log = log;
  }

  select(_column: string): this {
    return this;
  }

  where(column: keyof UserRow, operator: '=' | '<>', value: unknown): this {
    this.#where.push([column, operator, value]);
    return this;
  }

  limit(_count: number): this {
    return this;
  }

  async executeTakeFirst(): Promise<UserRow | undefined> {
    this.#log.push(this.#where.map(([column, operator, value]) => `${column} ${operator} ${String(value)}`).join(' and '));
    return this.#rows.find((row) => this.#where.every(([column, operator, value]) => (operator === '=' ? row[column] === value : row[column] !== value)));
  }
}

class UserRepository {
  static rows: UserRow[] = [
    { id: 1, email: 'ada@example.com', team: 1, deleted: false },
    { id: 2, email: 'alan@example.com', team: 2, deleted: false },
    { id: 3, email: 'gone@example.com', team: 1, deleted: true },
  ];
  readonly queries: string[] = [];

  query(): FakeQuery {
    return new FakeQuery(UserRepository.rows.filter((row) => !row.deleted), this.queries);
  }

  withTrashed(): FakeQuery {
    return new FakeQuery(UserRepository.rows, this.queries);
  }

  find(_id: number): Promise<UserRow | undefined> {
    return Promise.resolve(undefined);
  }
}

interface AuthState {
  user: { id: number };
}

class Authenticate {
  handle(ctx: HttpContext, next: Next<AuthState>) {
    return next({ user: { id: Number(ctx.request.headers.get('x-user') ?? 1) } });
  }
}

// ——— The routes ———

const ProfileRequest = defineRequest({
  schema: r.object({
    name: r.string().trim().required().max(20),
    email: r.string().trim().lowercase().required().email().unique(UserRepository, 'email', { ignore: (ctx) => ctx.user.id }),
  }),
  messages: { 'email.unique': 'profile.email_taken', max: 'Keep {attribute} under {max}.' },
  attributes: { email: 'profile.fields.email' },
});

class UpdateProfileController {
  static request = ProfileRequest;
  handle(ctx: ContextOf<typeof ProfileRequest>) {
    return ctx.body;
  }
}

/**
 * The unique index decides (two requests raced past `unique`): the handler throws what `failOnDuplicate()` of @marmeon/database
 * throws — a ValidationError of one `marmeon.validation.unique` issue, without labels. The router lends it the request's.
 */
const RaceRequest = defineRequest({
  schema: r.object({ email: r.string().trim().lowercase().required().email() }),
  messages: { 'email.unique': 'profile.email_taken' },
  attributes: { email: 'profile.fields.email' },
});
class RaceController {
  static request = RaceRequest;
  handle(ctx: ContextOf<typeof RaceRequest>) {
    const issue = { message: '', path: ['email'] };
    issue.message = translatable('marmeon.validation.unique', {}, 'The {attribute} has already been taken.')(issue);
    throw ValidationError.fromIssues([issue], ctx.body);
  }
}
const UnlabelledRaceRequest = defineRequest({ schema: r.object({ email: r.string().email() }) });
class UnlabelledRaceController {
  static request = UnlabelledRaceRequest;
  handle(ctx: ContextOf<typeof UnlabelledRaceRequest>) {
    const issue = { message: '', path: ['email'] };
    issue.message = translatable('marmeon.validation.unique', {}, 'The {attribute} has already been taken.')(issue);
    throw ValidationError.fromIssues([issue], ctx.body);
  }
}

/** The same rule, live on purpose (`.live()`): a team's slug, say — whether it is taken is no secret there. */
const LiveRequest = defineRequest({ schema: r.object({ email: r.email().unique(UserRepository, 'email').live() }) });
class LiveController {
  static request = LiveRequest;
  handle(ctx: ContextOf<typeof LiveRequest>) {
    return ctx.body;
  }
}

const InviteRequest = defineRequest({
  schema: r.object({ email: r.email().exists(UserRepository, 'email', { where: (query, ctx: HttpContext & AuthState) => query.where('team', '=', ctx.user.id) }) }),
});
class InviteController {
  static request = InviteRequest;
  handle(ctx: ContextOf<typeof InviteRequest>) {
    return ctx.body;
  }
}

/** Our schema inside a schema of another library — which calls ours without the request (no `libraryOptions`). */
function wrapped(inner: StandardSchemaV1): StandardSchemaV1 {
  return { '~standard': { version: 1, vendor: 'other', validate: (value) => inner['~standard'].validate(value) } };
}
// `live: true`: the request lets a live validation run its foreign schema (E206) — so only the mark on the issue (NOT_LIVE) keeps
// what our not-live rule found out of the answer.
const WrappedRequest = defineRequest({ schema: wrapped(r.object({ code: r.string().custom(async (code) => code !== 'taken') })), live: true });
class WrappedController {
  static request = WrappedRequest;
  handle(ctx: ContextOf<typeof WrappedRequest>) {
    return ctx.body;
  }
}

/**
 * A page builder's block (E208): a subtitle cleared on purpose is `''` — neither missing (the block keeps it empty) nor an error;
 * an empty number, link or choice is a form's empty field — missing.
 */
const BlockRequest = defineRequest({
  schema: r.object({
    title: r.string().trim().required().max(80),
    subtitle: r.string().trim().max(120).optional(),
    caption: r.string().nullable(),
    cta: r.string().default('Read more'),
    width: r.integer().min(1).optional(),
    link: r.url().nullable(),
    align: r.in(['left', 'center']).default('left'),
  }),
});
class BlockController {
  static request = BlockRequest;
  handle(ctx: ContextOf<typeof BlockRequest>) {
    return { ...ctx.body, has: Object.fromEntries(Object.entries(ctx.body).map(([key, value]) => [key, value === undefined ? 'undefined' : value === null ? 'null' : typeof value])) };
  }
}

function app() {
  const users = new UserRepository();
  const resolved: string[] = [];
  const router = new Router({
    resolve: (Class) => {
      resolved.push(Class.name);
      return (Class === (UserRepository as never) ? users : new Class()) as never;
    },
  }).load(
    defineRoutes((Route) => {
      Route.middleware(Authenticate).put('/profile', UpdateProfileController);
      Route.middleware(Authenticate).post('/live', LiveController);
      Route.middleware(Authenticate).post('/invite', InviteController);
      Route.post('/wrapped', WrappedController);
      Route.post('/race', RaceController);
      Route.post('/race-unlabelled', UnlabelledRaceController);
      Route.put('/block', BlockController);
    }),
  );
  const send = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const route = router.routes.find((candidate) => candidate.path === path)!;
    const form = body instanceof URLSearchParams;
    const request = new Request(`http://app.test${path}`, {
      method: route.methods[0],
      body: form ? body : JSON.stringify(body),
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers },
    });
    try {
      const response = await router.dispatch(route, { request, params: {} });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    } catch (error) {
      if (error instanceof ValidationError) return { status: 422, errors: error.errors, error };
      throw error;
    }
  };
  return { users, resolved, send, live: (path: string, body: unknown, fields: string) => send(path, body, { [VALIDATE_HEADER]: fields }) };
}

describe('database rules in a request', () => {
  it('unique gets its repository from the request (resolve), ignores the row being edited, counts soft-deleted rows', async () => {
    const { send, users } = app();
    expect(await send('/profile', { name: 'Ada', email: ' ADA@example.com ' }, { 'x-user': '1' })).toEqual({ status: 200, body: { name: 'Ada', email: 'ada@example.com' } });
    expect(users.queries).toEqual(['email = ada@example.com and id <> 1']);
    expect((await send('/profile', { name: 'Ada', email: 'alan@example.com' }, { 'x-user': '1' })).errors).toEqual({ email: ['profile.email_taken'] });
    // Soft-deleted: the unique index still holds it.
    expect((await send('/profile', { name: 'Ada', email: 'gone@example.com' }, { 'x-user': '1' })).errors).toEqual({ email: ['profile.email_taken'] });
  });

  it('exists: a row of the repository (not soft-deleted), narrowed by where', async () => {
    const { send } = app();
    expect((await send('/invite', { email: 'ada@example.com' }, { 'x-user': '1' })).status).toBe(200);
    expect((await send('/invite', { email: 'alan@example.com' }, { 'x-user': '1' })).errors).toEqual({ email: ['The selected email is invalid.'] });
    expect((await send('/invite', { email: 'gone@example.com' }, { 'x-user': '1' })).errors).toEqual({ email: ['The selected email is invalid.'] });
  });

  it('a database rule outside a request says so (a config, a job: no resolve)', async () => {
    const rule = r.object({ email: r.email().unique(UserRepository, 'email') });
    await expect(rule['~standard'].validate({ email: 'ada@example.com' }) as Promise<unknown>).rejects.toThrow("r.…unique() asks the database — it validates in a request (defineRequest)");
  });
});

describe('live validation (E62) never asks the database unless the rule says .live() (E187/E193/E197)', () => {
  it('the rule does not run: no query, and a taken and a free address get the same answer', async () => {
    const { live, users } = app();
    const taken = await live('/profile', { name: 'Ada', email: 'alan@example.com' }, 'email');
    const free = await live('/profile', { name: 'Ada', email: 'new@example.com' }, 'email');
    expect(taken).toEqual({ status: 204, body: null });
    expect(free).toEqual(taken);
    expect(users.queries, 'the database was asked in a live validation').toEqual([]);
    // The other rules of the field do run live.
    expect((await live('/profile', { name: 'Ada', email: 'nope' }, 'email')).errors).toEqual({ email: ['The profile.fields.email field must be a valid email address.'] });
  });

  it('a rule that ran anyway — inside another library\'s schema, without the request — is dropped by the live validation', async () => {
    const { live, send } = app();
    // The submit tells …
    expect((await send('/wrapped', { code: 'taken' })).errors).toEqual({ code: ['The code field is invalid.'] });
    // … a live validation never: the issue says its rule is not live.
    const taken = await live('/wrapped', { code: 'taken' }, 'code');
    expect(taken.errors, 'a live validation told what a not-live rule found').toBeUndefined();
    expect(taken).toEqual({ status: 204, body: null });
    expect(await live('/wrapped', { code: 'free' }, 'code')).toEqual({ status: 204, body: null });
  });

  it('.live() on an object, a list or a union throws — it would open every rule inside (the account\'s address too)', () => {
    const email = r.string().unique(UserRepository, 'email');
    expect(() => (r.object({ email }) as any).live()).toThrow(/\.live\(\) goes on the field/);
    expect(() => (r.array(email) as any).live()).toThrow(/\.live\(\) goes on the field/);
    expect(() => r.union([email, r.integer()]).live()).toThrow(/\.live\(\) goes on the field/);
    expect(() => r.object({ email }).optional().live()).toThrow(/\.live\(\) goes on the field/);
    // On the field it is what it says.
    expect(() => email.live().optional()).not.toThrow();
  });

  /** A repository whose every value is taken — it notes what it was asked. */
  const lookup = () => {
    const queries: string[] = [];
    class Lookup {
      query() {
        const chain = { select: () => chain, where: (_c: string, _o: string, value: unknown) => (queries.push(String(value)), chain), limit: () => chain, executeTakeFirst: async () => ({ x: 1 }) };
        return chain;
      }
    }
    const validateLive = (schema: StandardSchemaV1, value: unknown) =>
      schema['~standard'].validate(value, { libraryOptions: { marmeon: { resolve: (C: any) => new C(), ctx: {} as never, live: true } } } as never);
    return { queries, Lookup, validateLive };
  };

  it('a .live() field opens only itself — its neighbours in the same object stay closed', async () => {
    const { queries, Lookup, validateLive } = lookup();
    const schema = r.object({ email: r.string().unique(Lookup, 'email'), slug: r.string().unique(Lookup, 'slug').live() });
    const result = await validateLive(schema, { email: 'ada@example.com', slug: 'ada' });
    expect(queries, 'a live validation asked about the address').toEqual(['ada']);
    expect(result.issues?.map((issue) => issue.path?.map((segment) => (typeof segment === 'object' ? segment.key : segment)).join('.'))).toEqual(['slug']);
  });

  it('… what the refusal on a container prevents: an object opened as a whole would ask about the address too', async () => {
    const { queries, Lookup, validateLive } = lookup();
    let opened: StandardSchemaV1;
    try {
      opened = (r.object({ email: r.string().unique(Lookup, 'email'), slug: r.string().unique(Lookup, 'slug') }) as any).live();
    } catch {
      return; // refused, as it must be
    }
    await validateLive(opened, { email: 'ada@example.com', slug: 'ada' });
    expect(queries, 'a live validation asked about the address').toEqual([]);
  });

  it('.live() opts in: the rule runs and tells', async () => {
    const { live, users } = app();
    expect((await live('/live', { email: 'alan@example.com' }, 'email')).errors).toEqual({ email: ['The email has already been taken.'] });
    expect(await live('/live', { email: 'new@example.com' }, 'email')).toEqual({ status: 204, body: null });
    expect(users.queries).toHaveLength(2);
  });
});

describe('messages and attributes (Laravel\'s messages() and attributes())', () => {
  const german: Record<string, string> = {
    'profile.email_taken': 'Diese Adresse ist vergeben.',
    'profile.fields.email': 'E-Mail',
    'marmeon.validation.required': 'Das Feld {attribute} ist erforderlich.',
    'marmeon.validation.email': 'Das Feld {attribute} muss eine gültige E-Mail-Adresse sein.',
  };
  const translator: MessageTranslator = {
    has: (key) => Object.hasOwn(german, key),
    text: (key, params = {}, fallback) => (german[key] ?? fallback ?? key).replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)),
  };

  it('a request\'s own message per field and rule, or per rule; the field\'s name from attributes — translated when it is a key', async () => {
    const { send } = app();
    const result = await send('/profile', { name: 'A name that is far too long', email: 'nope' }, { 'x-user': '1' });
    expect(result.errors?.email?.[0], 'the name of attributes').toBe('The profile.fields.email field must be a valid email address.');
    // Without a translator: the texts, keys as they are.
    expect(result.errors).toEqual({ name: ['Keep name under 20.'], email: ['The profile.fields.email field must be a valid email address.'] });
    const translated = result.error!.translate(translator);
    expect(translated.errors.email?.[0], 'the name of attributes, translated').toBe('Das Feld E-Mail muss eine gültige E-Mail-Adresse sein.');
    expect(translated.errors).toEqual({ name: ['Keep name under 20.'], email: ['Das Feld E-Mail muss eine gültige E-Mail-Adresse sein.'] });
    const taken = (await send('/profile', { name: 'Ada', email: 'alan@example.com' }, { 'x-user': '1' })).error!.translate(translator);
    expect(taken.errors).toEqual({ email: ['Diese Adresse ist vergeben.'] });
    const missing = (await send('/profile', {}, { 'x-user': '1' })).error!.translate(translator);
    expect(missing.errors).toEqual({ name: ['Das Feld name ist erforderlich.'], email: ['Das Feld E-Mail ist erforderlich.'] });
  });

  it('a ValidationError of the handler (failOnDuplicate\'s, after a race) gets them too — the same text as the unique rule\'s', async () => {
    const { send } = app();
    const race = (await send('/race', { email: 'ada@example.com' })).error!;
    expect(race.labels, 'the router did not lend the request\'s labels').toEqual({ messages: { 'email.unique': 'profile.email_taken' }, attributes: { email: 'profile.fields.email' } });
    expect(race.translate(translator).errors).toEqual({ email: ['Diese Adresse ist vergeben.'] });
    expect(race.input).toEqual({ email: 'ada@example.com' });
    // A request without labels: the error as it was thrown.
    const plain = (await send('/race-unlabelled', { email: 'ada@example.com' })).error!;
    expect(plain.errors).toEqual({ email: ['The email has already been taken.'] });
  });

  it('a live validation\'s errors use them too', async () => {
    const { live } = app();
    const result = await live('/profile', { name: 'A name that is far too long', email: 'x' }, 'name');
    expect(result.errors).toEqual({ name: ['Keep name under 20.'] });
  });
});

describe('an empty string in a request — by type (E208)', () => {
  const { send } = app();
  const cleared = { title: 'Pricing', subtitle: '', caption: '', cta: '', width: '', link: '', align: '' };
  const expected = {
    title: 'Pricing',
    subtitle: '',
    caption: '',
    cta: '',
    link: null,
    align: 'left',
    has: { title: 'string', subtitle: 'string', caption: 'string', cta: 'string', width: 'undefined', link: 'null', align: 'string' },
  };

  it("JSON (a page builder): the cleared subtitle reaches the handler as '' — the empty number, link and choice are missing", async () => {
    const answer = await send('/block', cleared);
    expect((answer.body as { has?: Record<string, string> } | undefined)?.has?.subtitle, 'the cleared subtitle did not reach the handler').toBe('string');
    expect(answer).toEqual({ status: 200, body: expected });
  });

  it('a form sends the same strings — the same answer', async () => {
    const answer = await send('/block', new URLSearchParams(cleared));
    expect(answer.errors, `a form's empty fields were refused: ${JSON.stringify(answer.errors)}`).toBeUndefined();
    expect(answer).toEqual({ status: 200, body: expected });
  });

  it('left out, the fields are missing as ever — and an empty title is "required"', async () => {
    const left = await send('/block', { title: 'Pricing', caption: null, link: null });
    expect(left).toEqual({ status: 200, body: { title: 'Pricing', caption: null, cta: 'Read more', link: null, align: 'left', has: { title: 'string', caption: 'null', cta: 'string', link: 'null', align: 'string' } } });
    expect((await send('/block', { ...cleared, title: '  ' })).errors).toEqual({ title: ['The title field is required.'] });
  });
});
