import { ConsoleLogger } from '@bespokecore/core';
import { RequestNonce, type HttpContext } from '@bespokecore/router';
import { describe, expect, it } from 'vitest';
import { compilePolicy, contentSecurityPolicy, DEFAULT_CSP, NONCE } from './csp.ts';

const html = () => new Response('<p>page</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
const ctx = { request: new Request('http://app.test/page'), route: { path: '/page' } } as unknown as HttpContext;

describe('contentSecurityPolicy() (E147)', () => {
  it('compiles the strict default — the nonce\'s place kept for each response', () => {
    const { pieces, usesNonce } = compilePolicy(DEFAULT_CSP);
    expect(usesNonce).toBe(true);
    expect(pieces.join('N0NCE')).toBe("script-src 'nonce-N0NCE' 'strict-dynamic'; object-src 'none'; base-uri 'self'");
  });

  it('adds directives, leaves defaults out with false, writes flags without sources; refuses what would break the header', () => {
    const { pieces, usesNonce } = compilePolicy({ ...DEFAULT_CSP, scriptSrc: ["'self'"], baseUri: false, imgSrc: ["'self'", 'data:'], upgradeInsecureRequests: true });
    expect(usesNonce).toBe(false);
    expect(pieces).toEqual(["script-src 'self'; object-src 'none'; img-src 'self' data:; upgrade-insecure-requests"]);
    expect(() => compilePolicy({ scriptSrc: ["'self'; script-src *"] })).toThrow('is not a source');
    expect(() => compilePolicy({ imgSrc: ['a,b'] })).toThrow('is not a source');
    expect(() => compilePolicy({ ['script-src' as 'scriptSrc']: ["'self'"] })).toThrow('"script-src" is not a directive (camel-cased, like scriptSrc)');
  });

  it('sets the header on HTML only, with the response\'s nonce; Report-Only on request; a policy without NONCE wants none', async () => {
    const Policy = contentSecurityPolicy({ styleSrc: ["'self'", NONCE] });
    const nonce = new RequestNonce();
    const response = await new Policy(nonce, new ConsoleLogger()).handle(ctx, async () => html());
    expect(response.headers.get('content-security-policy')).toBe(
      `script-src 'nonce-${nonce.value}' 'strict-dynamic'; object-src 'none'; base-uri 'self'; style-src 'self' 'nonce-${nonce.value}'`,
    );
    const json = await new Policy(new RequestNonce(), new ConsoleLogger()).handle(ctx, async () => Response.json({}));
    expect(json.headers.get('content-security-policy')).toBeNull();

    const ReportOnly = contentSecurityPolicy({ reportOnly: true, reportUri: ['/csp'] });
    const reported = await new ReportOnly(new RequestNonce(), new ConsoleLogger()).handle(ctx, async () => html());
    expect(reported.headers.get('content-security-policy')).toBeNull();
    expect(reported.headers.get('content-security-policy-report-only')).toMatch(/^script-src 'nonce-[^']+' 'strict-dynamic'; .*; report-uri \/csp$/);

    const Static = contentSecurityPolicy({ scriptSrc: ["'self'"] });
    const untouched = new RequestNonce();
    const fixed = await new Static(untouched, new ConsoleLogger()).handle(ctx, async () => html());
    expect(fixed.headers.get('content-security-policy')).toBe("script-src 'self'; object-src 'none'; base-uri 'self'");
    expect(untouched.forDocument()).toBeUndefined(); // never wanted, never made
  });

  it('keeps the policy a response brings itself (a sandboxed file, the devtools\' pages)', async () => {
    const Policy = contentSecurityPolicy();
    const own = await new Policy(new RequestNonce(), new ConsoleLogger()).handle(ctx, async () => new Response('', { headers: { 'content-type': 'text/html', 'content-security-policy': 'sandbox' } }));
    expect(own.headers.get('content-security-policy')).toBe('sandbox');
  });
});
