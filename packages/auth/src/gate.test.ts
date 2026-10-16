import { createApplication, defineModule, err, type Container } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { abort, Controller, defineRequest, HttpServiceProvider, type ContextOf, type HttpContext } from '@marmeon/http';
import type { RouteBinder } from '@marmeon/router';
import { accessLabel } from '@marmeon/router/internal';
import { createHttpKernel } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { openRoutes } from './test-helpers/open-routes.ts';
import {
  abilities,
  AccessTokenStore,
  Auth,
  authenticate,
  AuthorizationError,
  AuthServiceProvider,
  can,
  deny,
  denyAsNotFound,
  Gate,
  RememberTokenStore,
  UserProvider,
  type AccessToken,
  type Authenticated,
  type AuthUser,
  type Credentials,
} from './index.ts';

interface Post {
  id: number;
  authorId: number;
  draft: boolean;
}
const posts = new Map<number, Post>([
  [1, { id: 1, authorId: 1, draft: false }],
  [2, { id: 2, authorId: 2, draft: true }],
  [3, { id: 3, authorId: 2, draft: false }],
]);

/** An injectable dependency of a policy — policies are ordinary classes. */
class Admins {
  has(user: AuthUser): boolean {
    return user.name === 'Root';
  }
}

class PostPolicy {
  readonly #admins: Admins;
  constructor(admins: Admins) {
    this.#admins = admins;
  }
  before(user: AuthUser) {
    if (this.#admins.has(user)) return true; // admins may do anything
    return undefined;
  }
  view(user: AuthUser, post: Post) {
    return !post.draft || post.authorId === user.id ? true : denyAsNotFound(); // others' drafts do not exist
  }
  update(user: AuthUser, post: Post) {
    return post.authorId === user.id || deny('Only the author can edit this post.');
  }
  async create(user: AuthUser) {
    return user.id !== 3; // the banned user
  }
}

class PostBinder implements RouteBinder<Post> {
  resolveRouteBinding(value: string) {
    return posts.get(Number(value));
  }
}

const UpdatePostRequest = defineRequest({
  schema: v.object({ title: v.pipe(v.string(), v.minLength(1)) }),
  authorize: can(PostPolicy, 'update', 'post'),
});
class UpdatePostController extends Controller {
  static request = UpdatePostRequest;
  handle(ctx: ContextOf<typeof UpdatePostRequest>) {
    return { updated: ctx.params.post.id, title: ctx.body.title };
  }
}

const ShowPostRequest = defineRequest({ authorize: can(PostPolicy, 'view', (ctx: HttpContext<Authenticated, { post: Post }>) => ctx.params.post) });
class ShowPostController extends Controller {
  static request = ShowPostRequest;
  readonly #gate: Gate;
  constructor(gate: Gate) {
    super();
    this.#gate = gate;
  }
  async handle(ctx: ContextOf<typeof ShowPostRequest>) {
    // What the UI may offer — explicit props, not a policy dump.
    return { id: ctx.params.post.id, can: { update: await this.#gate.allows(PostPolicy, 'update', ctx.params.post) } };
  }
}

const CreatePostRequest = defineRequest({ authorize: can(PostPolicy, 'create') });
class CreatePostController extends Controller {
  static request = CreatePostRequest;
  handle() {
    return { created: true };
  }
}

class DeletePostController extends Controller {
  readonly #gate: Gate;
  constructor(gate: Gate) {
    super();
    this.#gate = gate;
  }
  async handle(ctx: HttpContext<Authenticated, { post: Post }>) {
    await this.#gate.authorize(PostPolicy, 'update', ctx.params.post); // in code instead of at the request
    return { deleted: ctx.params.post.id };
  }
}

class SignInController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext<{}, { id: string }>) {
    await this.#auth.login(users.get(Number(ctx.params.id))!);
    return { ok: true };
  }
}

const users = new Map<number, AuthUser>([
  [1, { id: 1, name: 'Ada', email: 'ada@example.com' }],
  [2, { id: 2, name: 'Alan', email: 'alan@example.com' }],
  [3, { id: 3, name: 'Banned', email: 'banned@example.com' }],
  [4, { id: 4, name: 'Root', email: 'root@example.com' }],
]);
const provider: UserProvider = {
  findById: async (id) => (users.has(id as number) ? ({ user: users.get(id as number)!, passwordHash: null } as Credentials) : undefined),
  findForLogin: async () => undefined,
  updatePasswordHash: async () => {},
};
const noRemember: RememberTokenStore = { create: async () => '', consume: async () => err({ kind: 'invalid' }), exists: async () => false, forget: async () => {}, forgetUser: async () => {}, prune: async () => 0 };

/** API tokens in memory: the plain text is `<user>/<abilities>` — what the token guard needs, nothing more. */
const memoryTokens: AccessTokenStore = {
  create: async () => {
    throw new Error('not used');
  },
  find: async (plainText) => {
    const [user, granted = '*'] = plainText.split('/');
    if (!users.has(Number(user))) return undefined;
    return { id: Number(user), userId: Number(user), name: 'test', abilities: granted.split(','), lastUsedAt: null, expiresAt: null, createdAt: '' } satisfies AccessToken;
  },
  touch: async () => {},
  list: async () => [],
  revoke: async () => false,
  revokeAll: async () => 0,
  prune: async () => 0,
};

/** The handler asks the gate itself, so the registrar has no policy to name; a check of its own keeps the route from counting as open. */
const handlerAsks = () => true;

/** The `api` group: no session — the token guard says who it is, and the token must also grant `posts:write`. */
const apiRoutes = openRoutes((Route) => {
  const api = Route.middleware(authenticate('api'));
  const post = api.bind('post', PostBinder);
  post.get('/posts/:post', ShowPostController);
  // The order the docs show: the ability first, then the binding.
  api.middleware(abilities('posts:write')).bind('post', PostBinder).put('/posts/:post', UpdatePostController);
  post.middleware(abilities('posts:write')).authorize(handlerAsks).delete('/posts/:post', DeletePostController);
});

const routes = openRoutes((Route) => {
  Route.post('/as/:id', SignInController);
  Route.get('/login', () => 'login').name('auth.login');
  Route.get('/missing', () => abort(404));
  const signedIn = Route.middleware(authenticate());
  signedIn.post('/posts', CreatePostController);
  const post = signedIn.bind('post', PostBinder);
  post.get('/posts/:post', ShowPostController);
  post.put('/posts/:post', UpdatePostController);
  post.authorize(handlerAsks).delete('/posts/:post', DeletePostController);
  // The same policy asked once, at the registrar, for every route below it.
  const guarded = signedIn.bind('post', PostBinder).authorize(can(PostPolicy, 'view', 'post'));
  guarded.get('/guarded/:post', () => 'guarded');
  signedIn.authorize(() => deny('Not today.') as never).get('/denied', () => 'denied');
});

async function boot() {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'gate-test', routes, apiRoutes })],
  }, {
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, provider);
      container.instance(RememberTokenStore, noRemember);
      container.instance(AccessTokenStore, memoryTokens);
    },
  });
  const kernel = createHttpKernel(application);
  return Object.assign(async (as: number | undefined) => {
    let cookie = '';
    if (as !== undefined) {
      const response = await kernel.request(`/as/${as}`, { method: 'POST', headers: { accept: 'application/json' } });
      cookie = response.headers.getSetCookie().find((header) => header.startsWith('marmeon_session='))!.split(';')[0]!;
    }
    return async (method: string, path: string, json?: unknown) => {
      const response = await kernel.request(path, {
        method,
        headers: { cookie, accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) },
        ...(json ? { body: JSON.stringify(json) } : {}),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
  }, {
    /** A request of the `api` group with the bearer token `token` (`<user>/<abilities>`). */
    api: async (token: string, method: string, path: string, json?: unknown) => {
      const response = await kernel.request(`/api${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) },
        ...(json ? { body: JSON.stringify(json) } : {}),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  });
}

describe('policies at the request (can) — after route binding', () => {
  it('lets the author update and refuses others with the policy’s reason (403)', async () => {
    const as = await boot();
    expect(await (await as(1))('PUT', '/posts/1', { title: 'New' })).toEqual({ status: 200, body: { updated: 1, title: 'New' } });
    expect(await (await as(2))('PUT', '/posts/1', { title: 'New' })).toEqual({ status: 403, body: { message: 'Only the author can edit this post.' } });
  });

  it('authorizes before validating: a stranger learns nothing about the fields', async () => {
    const as = await boot();
    expect((await (await as(2))('PUT', '/posts/1', { title: '' })).status).toBe(403);
    expect((await (await as(1))('PUT', '/posts/1', { title: '' })).status).toBe(422);
  });

  it('denyAsNotFound answers exactly like a record that does not exist', async () => {
    const as = await boot();
    const ada = await as(1);
    const hidden = await ada('GET', '/posts/2'); // Alan's draft
    const missing = await ada('GET', '/posts/999');
    expect(hidden).toEqual(missing);
    expect(hidden).toEqual({ status: 404, body: { message: 'Not Found' } });
    expect(await (await as(2))('GET', '/posts/2')).toMatchObject({ status: 200 }); // the author sees it
  });

  it('asks can() at the registrar, after the binding: 403 for a refusal, 404 through denyAsNotFound(), and the user it is for', async () => {
    const as = await boot();
    expect(await (await as(2))('GET', '/guarded/2')).toMatchObject({ status: 200 }); // the author of the draft
    expect(await (await as(1))('GET', '/guarded/3')).toMatchObject({ status: 200 });
    expect(await (await as(1))('GET', '/guarded/2')).toEqual({ status: 404, body: { message: 'Not Found' } });
    expect((await (await as(1))('GET', '/guarded/999')).status).toBe(404);
    expect(await (await as(undefined))('GET', '/guarded/3')).toMatchObject({ status: 401 }); // authenticate() answers before the check
  });

  it('treats a policy response returned by a registrar check as a refusal, not a pass', async () => {
    const as = await boot();
    expect((await (await as(1))('GET', '/denied')).status).toBe(403);
  });

  it('runs before() first — an admin may do anything', async () => {
    const as = await boot();
    expect((await (await as(4))('PUT', '/posts/1', { title: 'Admin' })).status).toBe(200);
    expect((await (await as(4))('GET', '/posts/2')).status).toBe(200);
  });

  it('abilities without a resource, and guests (401 before any policy)', async () => {
    const as = await boot();
    expect((await (await as(1))('POST', '/posts')).status).toBe(200);
    expect((await (await as(3))('POST', '/posts')).status).toBe(403);
    expect((await (await as(undefined))('POST', '/posts')).status).toBe(401);
  });
});

describe('policies on api routes — the token guard tells the gate who it is', () => {
  it('lets a token user the policy allows through (200) and refuses one it does not (403) — can() at the request and the gate in code', async () => {
    const { api } = await boot();
    const expectAnswer = async (label: string, answer: Promise<{ status: number; body: unknown }>, expected: { status: number; body?: unknown }) => {
      const got = await answer;
      expect(got, `${label}: ${JSON.stringify(got)}`).toMatchObject(expected);
    };
    const update = (token: string) => api(token, 'PUT', '/posts/1', { title: 'By token' });
    await expectAnswer("the author's token", update('1/posts:write'), { status: 200, body: { updated: 1, title: 'By token' } });
    await expectAnswer("another user's token", update('2/posts:write'), { status: 403, body: { message: 'Only the author can edit this post.' } });
    await expectAnswer("an admin's token: before() decides", update('4/posts:write'), { status: 200 });
    await expectAnswer('gate.authorize() in a controller', api('1/posts:write', 'DELETE', '/posts/1'), { status: 200, body: { deleted: 1 } });
    await expectAnswer('gate.authorize() in a controller, another user', api('2/posts:write', 'DELETE', '/posts/1'), { status: 403 });
    await expectAnswer('gate.allows() in a controller', api('1/posts:read', 'GET', '/posts/1'), { status: 200, body: { id: 1, can: { update: true } } });
    await expectAnswer("another user's draft", api('2/posts:read', 'GET', '/posts/2'), { status: 200 });
    await expectAnswer("someone else's draft", api('1/posts:read', 'GET', '/posts/2'), { status: 404 });
  });

  it("still asks the token's abilities on top: the author's token without posts:write is refused (403) before any policy", async () => {
    const { api } = await boot();
    expect(await api('1/posts:read', 'PUT', '/posts/1', { title: 'By token' })).toEqual({ status: 403, body: { message: 'This token may not: posts:write.' } });
    expect((await api('nobody', 'PUT', '/posts/1', { title: 'x' })).status).toBe(401);
  });
});

describe('can() labels', () => {
  it('names the policy, the ability and where the resource comes from', () => {
    expect(accessLabel(can(PostPolicy, 'update', 'post'))).toBe('can PostPolicy.update(post)');
    expect(accessLabel(can(PostPolicy, 'view', (ctx: HttpContext<Authenticated, { post: Post }>) => ctx.params.post))).toBe('can PostPolicy.view(…)');
    expect(accessLabel(can(PostPolicy, 'create'))).toBe('can PostPolicy.create');
  });

  it('labels what untyped code passes instead of throwing', () => {
    const untyped = can as (...args: unknown[]) => never;
    expect(accessLabel(untyped(undefined, 'view'))).toBe('can Policy.view');
    expect(accessLabel(untyped(class {}, Symbol('x')))).toBe('can Policy.Symbol(x)');
  });
});

describe('Gate in code', () => {
  it('authorize() in a controller, allows() for what the UI may offer', async () => {
    const as = await boot();
    expect(await (await as(1))('GET', '/posts/1')).toEqual({ status: 200, body: { id: 1, can: { update: true } } });
    expect(await (await as(2))('GET', '/posts/1')).toEqual({ status: 200, body: { id: 1, can: { update: false } } });
    expect((await (await as(2))('DELETE', '/posts/1')).status).toBe(403);
    expect(await (await as(1))('DELETE', '/posts/1')).toEqual({ status: 200, body: { deleted: 1 } });
  });

  it('denies guests without asking the policy; inspect() tells why', async () => {
    let asked = 0;
    class CountingPolicy {
      edit() {
        asked++;
        return true;
      }
    }
    const resolve = <T>(Class: new (...args: any[]) => T) => (Class === (PostPolicy as unknown) ? (new PostPolicy(new Admins()) as T) : new Class());
    const guest = new Gate({ user: async () => undefined } as unknown as Auth, resolve);
    expect(await guest.allows(CountingPolicy, 'edit')).toBe(false);
    expect(asked).toBe(0);
    const alan = new Gate({ user: async () => users.get(2) } as unknown as Auth, resolve);
    expect(await alan.inspect(PostPolicy, 'update', posts.get(1)!)).toMatchObject({ allowed: false, status: 403, message: 'Only the author can edit this post.' });
    expect(await alan.denies(PostPolicy, 'view', posts.get(2)!)).toBe(false);
    await expect(new Gate({ user: async () => users.get(1) } as unknown as Auth, resolve).authorize(PostPolicy, 'view', posts.get(2)!)).rejects.toMatchObject({
      status: 404,
      message: 'Not Found',
    });
    expect(new AuthorizationError()).toMatchObject({ status: 403, message: 'This action is unauthorized.' });
  });
});

// --- Type guarantees (never called) -----------------------------------------------------------

declare const gate: Gate;
declare const post: Post;

export function policyTypes() {
  void gate.allows(PostPolicy, 'update', post);
  void gate.allows(PostPolicy, 'create');
  // @ts-expect-error — not an ability of PostPolicy
  void gate.allows(PostPolicy, 'publish', post);
  // @ts-expect-error — `before` is a hook, not an ability
  void gate.allows(PostPolicy, 'before');
  // @ts-expect-error — the resource has the wrong type
  void gate.allows(PostPolicy, 'update', { id: 1 });
  // @ts-expect-error — the resource is missing
  void gate.allows(PostPolicy, 'update');

  // @ts-expect-error — can() without the resource the ability needs
  can(PostPolicy, 'update');

  openRoutes((Route) => {
    const signedIn = Route.middleware(authenticate());
    signedIn.bind('post', PostBinder).put('/posts/:post', UpdatePostController);
    // @ts-expect-error — `post` is not bound here: a string, not a Post
    signedIn.put('/posts/:post', UpdatePostController);
    // @ts-expect-error — the policy needs a signed-in user: no authenticate()
    Route.bind('post', PostBinder).put('/posts/:post', UpdatePostController);

    signedIn.bind('post', PostBinder).authorize(can(PostPolicy, 'update', 'post'));
    // @ts-expect-error — the registrar binds no `post`
    signedIn.authorize(can(PostPolicy, 'update', 'post'));
  });
}
