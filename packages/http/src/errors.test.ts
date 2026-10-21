import { defineRoutes, HttpError, Router, ValidationError } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { DefaultExceptionHandler } from './errors.ts';
import { RedirectResult } from './redirect.ts';
import type { ViewResult } from './view.ts';

const handler = new DefaultExceptionHandler();
const router = new Router().load(defineRoutes(() => {}));
const options = { debug: false };
const flasher = { flash: () => {}, pull: () => undefined, queueFlash: () => {}, takeFlash: () => [], hasFlash: () => false };

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://app.test/users', { method: 'POST', headers });
}

/** The `Vary` names an answer lists, lower-cased. */
function varyOf(headers: Headers | Readonly<Record<string, string>> | undefined): string[] {
  const value = headers instanceof Headers ? headers.get('vary') : Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'vary')?.[1];
  return (value ?? '').toLowerCase().split(/\s*,\s*/).filter(Boolean);
}

describe('DefaultExceptionHandler Vary', () => {
  it('names Accept and x-marmeon on the error page', () => {
    const result = handler.render(new HttpError(404), request({ accept: 'text/html' }), options) as ViewResult;
    expect(varyOf(result.headers)).toEqual(['accept', 'x-marmeon']);
  });

  it('names Accept and x-marmeon on the JSON answer', () => {
    const response = handler.render(new HttpError(404), request({ accept: 'application/json' }), options) as Response;
    expect(response.status).toBe(404);
    expect(varyOf(response.headers)).toEqual(['accept', 'x-marmeon']);
  });

  it('names what expectsJson reads on the 422', () => {
    const response = handler.render(new ValidationError({ name: ['Required'] }), request({ accept: 'application/json' }), options) as Response;
    expect(response.status).toBe(422);
    expect(varyOf(response.headers)).toEqual(['accept', 'x-requested-with']);
  });

  it('names what expectsJson reads on the redirect back', () => {
    const result = handler.render(new ValidationError({ name: ['Required'] }), request({ accept: 'text/html' }), options);
    expect(result).toBeInstanceOf(RedirectResult);
    const response = (result as RedirectResult).toResponse(request({ accept: 'text/html' }), router, flasher);
    expect(varyOf(response.headers)).toEqual(['accept', 'x-requested-with']);
  });

  it('keeps the error\'s own Vary, appends the rest and adds no duplicates', () => {
    const own = handler.render(new HttpError(503, 'Down', { Vary: 'Origin' }), request(), options) as Response;
    expect(varyOf(own.headers)).toEqual(['origin', 'accept', 'x-marmeon']);

    const listed = handler.render(new HttpError(503, 'Down', { vary: 'ACCEPT, Origin' }), request({ accept: 'text/html' }), options) as ViewResult;
    expect(varyOf(listed.headers)).toEqual(['accept', 'origin', 'x-marmeon']);
  });

  it('leaves Vary: * alone', () => {
    const response = handler.render(new HttpError(503, 'Down', { Vary: '*' }), request(), options) as Response;
    expect(response.headers.get('vary')).toBe('*');
  });
});
