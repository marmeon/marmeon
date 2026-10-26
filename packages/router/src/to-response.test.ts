import { Html, html, raw } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { defaultToResponse } from './internal.ts';

const respond = (result: unknown) => defaultToResponse(result, undefined as never);

describe('defaultToResponse — strings and Html', () => {
  it('sends a string as text, its body unchanged', async () => {
    const response = await respond('<script>alert(1)</script>');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('<script>alert(1)</script>');
  });

  it('sends Html as HTML, with interpolated input escaped', async () => {
    const input = '<script>alert(1)</script>';
    const response = await respond(html`<p>${input}</p>`);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('keeps objects as JSON', async () => {
    expect((await respond({ a: 1 })).headers.get('content-type')).toContain('application/json');
  });

  it('refuses an object that has the prototype of Html but was not made by it', () => {
    const forged = Object.assign(Object.create(Html.prototype), { toString: () => '<script>x</script>' });
    expect(() => respond(forged)).toThrow(TypeError);
  });

  it('sends an object that only looks like Html as JSON, also after a JSON round trip', async () => {
    const lookalike = { toString: () => '<script>x</script>', __html: '<script>x</script>' };
    for (const result of [lookalike, JSON.parse('{"__html":"<script>x</script>"}')]) {
      expect((await respond(result)).headers.get('content-type')).toContain('application/json');
    }
  });

  it('sends raw markup as HTML, its body unchanged', async () => {
    const response = await respond(raw('<b>x</b>'));
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('<b>x</b>');
  });

  it('answers null and undefined with 204', async () => {
    expect((await respond(null)).status).toBe(204);
    expect((await respond(undefined)).status).toBe(204);
  });

  it('answers an empty string with 200, text and an empty body', async () => {
    const response = await respond('');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('');
  });
});
