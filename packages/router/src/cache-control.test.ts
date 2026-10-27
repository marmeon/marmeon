import { describe, expect, it } from 'vitest';
import { keepFromSharedCaches, SharedCacheWarnings } from './cache-control.ts';

const answer = (headers: Record<string, string> = {}) => new Response('x', { headers });

describe('keepFromSharedCaches', () => {
  it.each([
    ['public, max-age=60', 'private, max-age=60', 'downgraded'],
    ['s-maxage=600, max-age=60', 'private, max-age=60', 'downgraded'],
    ['Public, Max-Age=60', 'private, Max-Age=60', 'downgraded'],
    ['PUBLIC , proxy-revalidate,immutable', 'private, immutable', 'downgraded'],
    ['max-age=60', 'private, max-age=60', 'changed'],
    ['private="set-cookie", max-age=60', 'private, max-age=60', 'changed'],
    ['private="a, b", max-age=60', 'private, max-age=60', 'changed'],
    ['public, community="UCI, Fresh", max-age=60', 'private, community="UCI, Fresh", max-age=60', 'downgraded'],
  ])('%s becomes %s (%s)', (before, after, outcome) => {
    const result = keepFromSharedCaches(answer({ 'cache-control': before }));
    expect(result.response.headers.get('cache-control')).toBe(after);
    expect(result.outcome).toBe(outcome);
  });

  it('gives an answer without the header private', () => {
    const result = keepFromSharedCaches(answer());
    expect(result.response.headers.get('cache-control')).toBe('private');
    expect(result.outcome).toBe('changed');
  });

  it.each(['no-store', 'private, max-age=60', 'no-store, private'])('leaves %s as it is', (value) => {
    const original = answer({ 'cache-control': value });
    const result = keepFromSharedCaches(original);
    expect(result.outcome).toBe('kept');
    expect(result.response).toBe(original);
    expect(result.response.headers.get('cache-control')).toBe(value);
  });

  it('removes the headers a CDN obeys instead of Cache-Control, also from a no-store answer', () => {
    const result = keepFromSharedCaches(answer({ 'cache-control': 'no-store', 'cdn-cache-control': 'max-age=600', 'surrogate-control': 'max-age=600' }));
    expect(result.outcome).toBe('downgraded');
    expect(result.response.headers.has('cdn-cache-control')).toBe(false);
    expect(result.response.headers.has('surrogate-control')).toBe(false);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
  });

  it('does not change a response that requests may share', () => {
    const constant = new Response(null, { headers: { 'cache-control': 'public' } });
    const result = keepFromSharedCaches(constant);
    expect(constant.headers.get('cache-control')).toBe('public');
    expect(result.response.headers.get('cache-control')).toBe('private');
  });
});

describe('SharedCacheWarnings', () => {
  it('is true once per key and takes no new keys past 500', () => {
    const warnings = new SharedCacheWarnings();
    expect(warnings.first('GET /a')).toBe(true);
    expect(warnings.first('GET /a')).toBe(false);
    for (let index = 1; index < 500; index++) warnings.first(`GET /${index}`);
    expect(warnings.first('GET /one-too-many')).toBe(false);
  });
});
