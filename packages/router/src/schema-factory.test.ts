import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { everyone } from './access.ts';
import { HttpError } from './errors.ts';
import { defineRequest } from './request-definition.ts';
import { defineRoutes, Router, type RouteDefinitions } from './router.ts';
import type { HttpContext, RouteBinder } from './types.ts';

interface Event {
  id: number;
  questions: string[];
}

const log: string[] = [];

class Events implements RouteBinder<Event> {
  resolveRouteBinding(value: string) {
    log.push('bind');
    return value === '1' ? { id: 1, questions: ['diet', 'shirt'] } : undefined;
  }
}

/** A form whose fields are the event's questions: built from the bound record, asynchronously. */
class Answers {
  static request = defineRequest({
    schema: async (_resolve, ctx: HttpContext<{}, { event?: Event }>) => {
      log.push('schema');
      await Promise.resolve();
      const questions = ctx.params.event?.questions ?? [];
      return v.object({ answers: v.object(Object.fromEntries(questions.map((key) => [key, v.pipe(v.string(), v.minLength(2, 'Too short.'))]))) });
    },
    authorize: () => {
      log.push('authorize');
      return true;
    },
  });
  handle(ctx: HttpContext<{ body: { answers: Record<string, string> } }>) {
    log.push('handle');
    return JSON.stringify(ctx.body.answers);
  }
}

class Refused {
  static request = defineRequest({
    schema: () => {
      log.push('schema');
      return v.object({});
    },
    authorize: () => false,
  });
  handle() {
    log.push('handle');
    return 'handled';
  }
}

class Broken {
  static request = defineRequest({
    schema: async (): Promise<ReturnType<typeof v.object>> => {
      log.push('schema');
      throw new HttpError(503, 'Questions are unavailable.');
    },
  });
  handle() {
    log.push('handle');
    return 'handled';
  }
}

class Crashing {
  static request = defineRequest({
    schema: (): ReturnType<typeof v.object> => {
      log.push('schema');
      throw new Error('database is down');
    },
  });
  handle() {
    log.push('handle');
    return 'handled';
  }
}

function load(register: RouteDefinitions['register']): Router {
  return new Router().load(defineRoutes(register));
}

async function call(router: Router, path: string, init: RequestInit = {}, params: Record<string, string> = {}) {
  const route = router.routes.find((candidate) => candidate.path === path)!;
  try {
    const response = await router.dispatch(route, { request: new Request(`http://app.test${path}`, init), params });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, body: error.message };
    throw error;
  }
}

const post = (answers: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: 'POST',
  body: JSON.stringify({ answers }),
  headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
});

describe('a schema built per request', () => {
  const router = load((Route) => {
    const open = Route.authorize(everyone);
    open.bind('event', Events).post('/events/:event', Answers);
    open.bind('event', Events).post('/refused/:event', Refused);
    Route.authorize(() => false).post('/checked', Refused);
    Route.authorize(everyone)
      .afterAuthorize(() => {
        throw new HttpError(404);
      })
      .post('/hooked', Broken);
    open.post('/broken', Broken);
    open.post('/crashing', Crashing);
  });

  it('builds the schema from the bound record, asynchronously, after the binder and authorize', async () => {
    log.length = 0;
    const response = await call(router, '/events/:event', post({ diet: 'vegan', shirt: 'M!' }), { event: '1' });
    expect(response).toEqual({ status: 200, body: '{"diet":"vegan","shirt":"M!"}' });
    expect(log).toEqual(['bind', 'authorize', 'schema', 'handle']);
  });

  it('reports a failing answer under answers.<key>, and the controller does not run', async () => {
    log.length = 0;
    const response = await call(router, '/events/:event', post({ diet: 'v', shirt: 'M!' }), { event: '1' });
    expect(response.status).toBe(422);
    expect(response.body).toContain('Too short.');
    expect(log).toEqual(['bind', 'authorize', 'schema']);
  });

  it('never builds the schema for a request whose authorize says no', async () => {
    log.length = 0;
    expect(await call(router, '/refused/:event', post({}), { event: '1' })).toMatchObject({ status: 403 });
    expect(log).toEqual(['bind']);
  });

  it('never builds the schema for a request a check refuses, or whose binder finds nothing', async () => {
    log.length = 0;
    expect(await call(router, '/checked', post({}))).toMatchObject({ status: 403 });
    expect(await call(router, '/events/:event', post({}), { event: '9' })).toMatchObject({ status: 404 });
    expect(log).toEqual(['bind']);
  });

  it('never builds the schema for a request an afterAuthorize hook answers', async () => {
    log.length = 0;
    expect(await call(router, '/hooked', post({}))).toMatchObject({ status: 404 });
    expect(log).toEqual([]);
  });

  it('builds it for a live validation too, after authorize and never for a refused one', async () => {
    log.length = 0;
    const live = { 'x-marmeon-validate': 'answers.diet' };
    const ok = await call(router, '/events/:event', post({ diet: 'vegan', shirt: 'M' }, live), { event: '1' });
    // Fail-closed: the schema is Valibot's, not `rules`, and the request does not say `live`.
    expect(ok.status).toBe(204);
    expect(log).toEqual(['bind', 'authorize', 'schema']);
    log.length = 0;
    expect(await call(router, '/refused/:event', post({}, live), { event: '1' })).toMatchObject({ status: 403 });
    expect(log).toEqual(['bind']);
  });

  it('answers with the error of a factory that rejects, and runs no controller', async () => {
    log.length = 0;
    expect(await call(router, '/broken', post({}))).toEqual({ status: 503, body: 'Questions are unavailable.' });
    expect(log).toEqual(['schema']);
  });

  it('lets the error of a factory that throws out, and runs no controller', async () => {
    log.length = 0;
    await expect(call(router, '/crashing', post({}))).rejects.toThrow('database is down');
    expect(log).toEqual(['schema']);
  });
});
