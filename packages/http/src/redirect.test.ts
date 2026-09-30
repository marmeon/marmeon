import { defineRoutes, Router, type HttpContext } from '@bespokecore/router';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { Controller } from './controller.ts';
import { isRedirectResult, RedirectResult } from './redirect.ts';
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

  it('carries extra headers and fails loudly without a target', () => {
    expect(new RedirectResult('/').header('x-reason', 'moved').toResponse(request(), router).headers.get('x-reason')).toBe('moved');
    expect(() => new RedirectResult().toResponse(request(), router)).toThrow('redirect() needs a target');
    expect(() => new RedirectResult().route('nope').toResponse(request(), router)).toThrow('Route [nope] is not defined.');
  });

  it('flashes with() data through the Flasher — and refuses to drop it silently without one', () => {
    const flashed: Record<string, unknown> = {};
    const flasher = { flash: (key: string, value: unknown) => (flashed[key] = value) };
    new RedirectResult('/').with('status', 'Saved.').with({ count: 2 }).toResponse(request(), router, flasher);
    expect(flashed).toEqual({ status: 'Saved.', count: 2 });

    expect(() => new RedirectResult('/').with('status', 'x').toResponse(request(), router)).toThrow(
      'redirect().with() needs a session: install @bespokecore/session and start it for this route.',
    );
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
    expectTypeOf<PageProps<UpdateThingController>>().toEqualTypeOf<{ readonly saved: true }>();
    expectTypeOf<PageProps<OnlyRedirectsController>>().toBeNever();
  });

  it('guards input, cookies and redirects', () => {
    const check = async (ctx: HttpContext) => {
      const input = await ctx.input();
      // @ts-expect-error -- input values are unknown until validated (step 6), not any
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
