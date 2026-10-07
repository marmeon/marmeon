import { createApplication, defineModule, type Container } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { abort, Controller, defineRequest, defineRoutes, HttpServiceProvider, type ContextOf, type HttpContext } from '@marmeon/http';
import type { RouteBinder } from '@marmeon/router';
import { createHttpKernel } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
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
const noRemember: RememberTokenStore = { create: async () => '', consume: async () => undefined, forget: async () => {}, forgetUser: async () => {}, prune: async () => 0 };

const routes = defineRoutes((Route) => {
  Route.post('/as/:id', SignInController);
  Route.get('/login', () => 'login').name('auth.login');
  Route.get('/missing', () => abort(404));
  const signedIn = Route.middleware(authenticate());
  signedIn.post('/posts', CreatePostController);
  const post = signedIn.bind('post', PostBinder);
  post.get('/posts/:post', ShowPostController);
  post.put('/posts/:post', UpdatePostController);
  post.delete('/posts/:post', DeletePostController);
});

async function boot() {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' },
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'gate-test', routes })],
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, provider);
      container.instance(RememberTokenStore, noRemember);
    },
  });
  const kernel = createHttpKernel(application);
  return async (as: number | undefined) => {
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
  };
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

  it('counter-check: denyAsNotFound answers exactly like a record that does not exist', async () => {
    const as = await boot();
    const ada = await as(1);
    const hidden = await ada('GET', '/posts/2'); // Alan's draft
    const missing = await ada('GET', '/posts/999');
    expect(hidden).toEqual(missing);
    expect(hidden).toEqual({ status: 404, body: { message: 'Not Found' } });
    expect(await (await as(2))('GET', '/posts/2')).toMatchObject({ status: 200 }); // the author sees it
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

  defineRoutes((Route) => {
    const signedIn = Route.middleware(authenticate());
    signedIn.bind('post', PostBinder).put('/posts/:post', UpdatePostController);
    // @ts-expect-error — `post` is not bound here: a string, not a Post
    signedIn.put('/posts/:post', UpdatePostController);
    // @ts-expect-error — the policy needs a signed-in user: no authenticate()
    Route.bind('post', PostBinder).put('/posts/:post', UpdatePostController);
  });
}
