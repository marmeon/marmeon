import type { HttpContext } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { AssetVersion, CheckAssetVersion } from './asset-version.ts';

const check = async (url: string, { version = 'v1', current = 'v2', method = 'GET' } = {}) => {
  const ctx = { request: new Request(url, { method, headers: { 'x-marmeon': '1', 'x-marmeon-version': version } }) } as unknown as HttpContext;
  return new CheckAssetVersion({ value: current } satisfies AssetVersion).handle(ctx, async () => new Response('page'));
};

describe('CheckAssetVersion', () => {
  it('names only path and query, not the address a proxy forwarded to', async () => {
    const response = await check('http://10.0.0.5:3000/x?y=1');
    expect([response.status, response.headers.get('x-marmeon-location')]).toEqual([409, '/x?y=1']);
  });

  it('never turns a request path into another host', async () => {
    for (const url of ['http://10.0.0.5:3000//evil.example/x?y=1', 'http://10.0.0.5:3000/\\evil.example/x?y=1']) {
      const location = (await check(url)).headers.get('x-marmeon-location')!;
      expect(location).toBe('/evil.example/x?y=1');
      expect(new URL(location, 'https://app.test').origin).toBe('https://app.test');
    }
  });

  it('is never cached, and varies on the headers that decide it', async () => {
    const response = await check('http://10.0.0.5:3000/x');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')?.toLowerCase().split(/\s*,\s*/)).toEqual(expect.arrayContaining(['x-marmeon', 'x-marmeon-version']));
  });

  it('lets a current build and a form submit through', async () => {
    expect((await check('http://localhost/x', { version: 'v2' })).status).toBe(200);
    expect((await check('http://localhost/x', { method: 'POST' })).status).toBe(200);
  });
});
