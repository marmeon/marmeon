import { describe, expect, it } from 'vitest';
import { Controller } from './controller.ts';
import { json } from './json.ts';
import { RedirectResult } from './redirect.ts';
import { view } from './view.ts';

class Probe extends Controller {
  page(status?: number) {
    return this.view('things/Edit', { saved: true }, status === undefined ? undefined : { status });
  }

  data() {
    return this.json({ ok: true }, { status: 201, headers: { location: '/things/1' } });
  }

  types() {
    // @ts-expect-error -- the status goes into the options: { status: 422 }
    this.view('things/Edit', { saved: true }, 422);
    // @ts-expect-error -- the status goes into the options: { status: 201 }
    this.json({ ok: true }, 201);
    // @ts-expect-error -- a redirect's status is set with .status(301)
    this.redirect('/x', 301);
    // @ts-expect-error -- a redirect's status is set with .status(301)
    new RedirectResult('/x', 301);
  }
}

describe('result options', () => {
  it('gives a page a status and headers', () => {
    expect(view('things/Edit', { saved: true }).status).toBe(200);
    const result = view('things/Edit', { saved: true }, { status: 422, headers: { 'retry-after': '5' } });
    expect(result.status).toBe(422);
    expect(result.headers).toEqual({ 'retry-after': '5' });
    expect(new Probe().page(410).status).toBe(410);
    expect(new Probe().page().status).toBe(200);
  });

  it('gives JSON a status and headers', () => {
    expect(json({ a: 1 }).status).toBe(200);
    const result = new Probe().data();
    expect(result.status).toBe(201);
    expect(result.headers).toEqual({ location: '/things/1' });
  });

  it('refuses a number where the options belong', () => {
    expect(() => view('things/Edit', { saved: true }, 422 as never)).toThrow(new TypeError('view(): pass the status as { status: 422 }'));
    expect(() => json({ a: 1 }, 201 as never)).toThrow(new TypeError('json(): pass the status as { status: 422 }'));
    expect(() => json({ a: 1 }, null as never)).toThrow(TypeError);
  });
});
