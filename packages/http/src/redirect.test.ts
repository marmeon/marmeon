import { defineRoutes, Router, type HttpContext } from '@marmeon/router';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { Controller } from './controller.ts';
import { INTENDED_KEY, isLocalPath, isRedirectResult, RedirectResult } from './redirect.ts';
import type { PageProps } from './view.ts';

const router = new Router().load(
  defineRoutes((Route) => {
    Route.get('/users/:id', () => 'user').name('user-profile.show');
  }),
);

function request(method = 'GET', headers: Record<string, string> = {}): Request {
  return new Request('http://app.test/profile/edit', { method, headers });
}

describe('RedirectResult', () => {
  it('redirects to a URL or a named route', () => {
    expect(new RedirectResult('/login').toResponse(request(), router).headers.get('location')).toBe('/login');
    const toRoute = new RedirectResult().route('user-profile.show', { id: 7 }).toResponse(request(), router);
    expect(toRoute.headers.get('location')).toBe('/users/7');
  });

  it('answers GET with 302 and other methods with 303, unless told otherwise', () => {
    expect(new RedirectResult('/').toResponse(request('GET'), router).status).toBe(302);
    expect(new RedirectResult('/').toResponse(request('PUT'), router).status).toBe(303);
    expect(new RedirectResult('/').toResponse(request('POST'), router).status).toBe(303);
    expect(new RedirectResult('/', 301).toResponse(request('POST'), router).status).toBe(301);
    expect(new RedirectResult('/').status(307).toResponse(request('DELETE'), router).status).toBe(307);
  });

  it('goes back to the referring page of this site only — never to another host', () => {
    const back = (referer?: string) =>
      new RedirectResult()
        .back('/dashboard')
        .toResponse(request('POST', referer ? { referer } : {}), router)
        .headers.get('location');

    expect(back('http://app.test/users/1?tab=bio')).toBe('/users/1?tab=bio');
    expect(back('https://evil.test/phish')).toBe('/dashboard');
    expect(back('not a url')).toBe('/dashboard');
    expect(back()).toBe('/dashboard');
  });

  it('never turns the referring page into a location on another host', () => {
    const back = (referer: string) => new RedirectResult().back('/dashboard').toResponse(request('POST', { referer }), router).headers.get('location');
    for (const referer of ['https://app.test//evil.example', 'http://app.test/\\evil.example', 'http://app.test\\\\evil.example', 'http://app.test/\t/evil.example']) {
      expect(back(referer), referer).toBe('/evil.example');
    }
    expect(back('http://app.test///evil.example/x?a=1')).toBe('/evil.example/x?a=1');
    expect(back('http://app.test//%2f/evil.example')).toBe('/%2f/evil.example');
    expect(back('http://app.test/%2f/evil.example')).toBe('/%2f/evil.example');
  });

  it('carries extra headers and fails loudly without a target', () => {
    expect(new RedirectResult('/').header('x-reason', 'moved').toResponse(request(), router).headers.get('x-reason')).toBe('moved');
    expect(() => new RedirectResult().toResponse(request(), router)).toThrow('redirect() needs a target');
    expect(() => new RedirectResult().route('nope').toResponse(request(), router)).toThrow('Route [nope] is not defined.');
  });

  it('flashes with() data through the Flasher — and refuses to drop it silently without one', () => {
    const flashed: Record<string, unknown> = {};
    const flasher = { flash: (key: string, value: unknown) => (flashed[key] = value), pull: () => undefined, queueFlash: () => {}, takeFlash: () => [], hasFlash: () => false };
    new RedirectResult('/').with('status', 'Saved.').with({ count: 2 }).toResponse(request(), router, flasher);
    expect(flashed).toEqual({ status: 'Saved.', count: 2 });

    expect(() => new RedirectResult('/').with('status', 'x').toResponse(request(), router)).toThrow(
      'redirect().with() needs a session: install @marmeon/session and start it for this route.',
    );
  });

  it('queues flash() messages — each with an id of its own, the same message twice is two — and needs a session for them', () => {
    const queued: { id: string; key: string; data: unknown }[] = [];
    const flasher = { flash: () => {}, pull: () => undefined, queueFlash: (message: { id: string; key: string; data: unknown }) => void queued.push(message), takeFlash: () => [], hasFlash: () => false };
    const saved = { kind: 'success', message: 'Saved.' };
    new RedirectResult('/').flash('toast', saved).flash('toast', saved).toResponse(request('POST'), router, flasher);
    expect(queued.map(({ key, data }) => ({ key, data }))).toEqual([{ key: 'toast', data: saved }, { key: 'toast', data: saved }]);
    expect(new Set(queued.map((message) => message.id)).size).toBe(2);
    expect(() => new RedirectResult('/').flash('toast', saved).toResponse(request(), router)).toThrow('redirect().flash() needs a session');
  });

  it('goes to the intended page once (authenticate() stored it), else to the fallback target', () => {
    const stored: Record<string, unknown> = { [INTENDED_KEY]: '/users/7/edit?tab=links' };
    const flasher = { flash: () => {}, pull: (key: string) => { const value = stored[key]; delete stored[key]; return value; }, queueFlash: () => {}, takeFlash: () => [], hasFlash: () => false };
    const intended = () => new RedirectResult().intended().route('user-profile.show', { id: 1 }).toResponse(request('POST'), router, flasher);
    expect(intended().headers.get('location')).toBe('/users/7/edit?tab=links');
    expect(intended().headers.get('location')).toBe('/users/1'); // pulled: used once
    expect(new RedirectResult('/home').intended().toResponse(request(), router).headers.get('location')).toBe('/home'); // no session
  });

  it('an intended URL pointing elsewhere is never followed (open redirect)', () => {
    for (const evil of ['//evil.test/phish', '/\\evil.test', 'https://evil.test/', '/\tevil', 'javascript:alert(1)', '', 42]) {
      expect(isLocalPath(evil), String(evil)).toBe(false);
      const flasher = { flash: () => {}, pull: () => evil, queueFlash: () => {}, takeFlash: () => [], hasFlash: () => false };
      expect(new RedirectResult('/home').intended().toResponse(request(), router, flasher).headers.get('location')).toBe('/home');
    }
    expect(isLocalPath('/users/1?q=a//b')).toBe(true);
    expect(isLocalPath('/a/..//evil.example')).toBe(false);
    expect(isLocalPath('/a/%2e%2e//evil.example')).toBe(false);
    expect(isLocalPath('/.//evil.example')).toBe(false);
    expect(isLocalPath('/a/../b')).toBe(true);
  });

  it('never flashes a field with "password" in its name, files or the CSRF token', () => {
    const flashed: Record<string, unknown> = {};
    const flasher = { flash: (key: string, value: unknown) => (flashed[key] = value), pull: () => undefined, queueFlash: () => {}, takeFlash: () => [], hasFlash: () => false };
    const input = {
      email: 'ada@example.com',
      password: 'secret',
      password_confirmation: 'secret',
      current_password: 'old',
      new_password: 'new',
      Password: 'x',
      _token: 'csrf',
      avatar: new File(['x'], 'a.png'),
      nested: { password: 'deep', name: 'n' },
    };
    new RedirectResult('/').withInput(input).toResponse(request('POST'), router, flasher);
    expect(flashed._old_input).toEqual({ email: 'ada@example.com', nested: { name: 'n' } });
  });

  it('is recognised by brand, not by class identity', () => {
    expect(isRedirectResult(new RedirectResult('/'))).toBe(true);
    expect(isRedirectResult({ location: '/' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type guarantees
// ---------------------------------------------------------------------------

class UpdateThingController extends Controller {
  async handle(ctx: HttpContext) {
    const input = await ctx.input();
    if (!input.name) return this.back();
    if (input.name === 'x') return this.redirect().route('things.show', { id: 1 });
    return this.view('things/Edit', { saved: true });
  }
}

class OnlyRedirectsController extends Controller {
  handle() {
    return this.redirect('/elsewhere');
  }
}

describe('types', () => {
  it('keeps page props free of redirect branches', () => {
    // Only `saved` is checked: PageProps also carries the shared props, and test files augment those.
    expectTypeOf<PageProps<UpdateThingController>['saved']>().toEqualTypeOf<true>();
    expectTypeOf<PageProps<OnlyRedirectsController>>().toBeNever();
  });

  it('guards input, cookies and redirects', () => {
    const check = async (ctx: HttpContext) => {
      const input = await ctx.input();
      // @ts-expect-error -- input values are unknown until validated, not any
      input.name.toUpperCase();
      // @ts-expect-error -- cookie values are strings
      ctx.cookies.set('count', 1);
      // @ts-expect-error -- route parameters are strings or numbers
      new RedirectResult().route('users.show', { id: { nested: true } });
      // @ts-expect-error -- 304 is not a redirect status
      new RedirectResult('/', 304);
    };
    expect(check).toBeTypeOf('function');
  });
});
