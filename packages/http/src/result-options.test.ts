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

  it('refuses a status that is not a whole number from 200 to 599', () => {
    for (const status of [0, 199, 600, 1000, 200.5, Number.NaN]) {
      expect(() => json({}, { status }), `json ${status}`).toThrow(TypeError);
      expect(() => view('things/Edit', {}, { status }), `view ${status}`).toThrow(TypeError);
    }
    expect(() => json({}, { status: 1000 })).toThrow(new TypeError('json(): status is a whole number from 200 to 599, not 1000.'));
    expect(json({}, { status: 599 }).status).toBe(599);
  });

  it('refuses 204, 205 and 304 with a body, and allows them without one', () => {
    for (const status of [204, 205, 304]) {
      expect(() => json({}, { status })).toThrow(TypeError);
      expect(() => view('things/Edit', {}, { status })).toThrow(TypeError);
      expect(json(undefined, { status }).status).toBe(status);
    }
  });

  it('names the way out of a status that has no body', () => {
    expect(() => json({}, { status: 204 })).toThrow(new TypeError('json(): status 204 has no body — pass undefined as the data.'));
    expect(() => json(null, { status: 204 })).toThrow(TypeError);
    expect(() => view('things/Edit', {}, { status: 304 })).toThrow(new TypeError('view(): status 304 has no body, and a page always has one.'));
  });

  it('quotes a status that is no number', () => {
    expect(() => json({}, { status: '201' as unknown as number })).toThrow(new TypeError('json(): status is a whole number from 200 to 599, not "201".'));
    expect(() => json({}, { status: Number.NaN })).toThrow(new TypeError('json(): status is a whole number from 200 to 599, not NaN.'));
  });

  it('reads the status once: an option that changes after the check never reaches the result', () => {
    let reads = 0;
    const options = { get status() { return reads++ === 0 ? 200 : 999; } };
    for (const make of [() => json({}, options), () => view('things/Edit', {}, options)]) {
      reads = 0;
      expect(make().status).toBe(200);
    }
  });
});
