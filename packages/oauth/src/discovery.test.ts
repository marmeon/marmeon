import { errorCodeOf } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { describe, expect, it } from 'vitest';
import { OAuthSetupError } from './config.ts';
import type { OAuthHttp } from './definition.ts';
import { createDiscovery } from './discovery.ts';
import { OAuthHttpError } from './http.ts';
import { recordingLogger } from './test-helpers/flow.ts';
import { oidcWith, DISCOVERY_URL, discoveryDocument, ISSUER, NOW } from './test-helpers/oidc.ts';

/** An `OAuthHttp` that answers from `answers` one by one (an `Error` is thrown, a function waited for) and counts the requests. */
function scripted(...answers: unknown[]) {
  const urls: string[] = [];
  const http: OAuthHttp = {
    json: async (url) => {
      urls.push(url);
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? (answer as () => Promise<unknown>)() : answer;
    },
  };
  return { http, urls };
}

const setup = (userinfo = false) => {
  const clock = new TestClock();
  clock.freeze(NOW);
  return { clock, discover: createDiscovery({ url: DISCOVERY_URL, issuer: ISSUER, userinfo, now: () => clock.now(), local: false }) };
};

describe('createDiscovery()', () => {
  it('refuses a discovery document whose issuer differs by one character (A10)', async () => {
    for (const issuer of [`${ISSUER}/`, 'https://idp.example.com.', 'https://Idp.example.com', 'https://idp.example.co', undefined, 7]) {
      const { discover } = setup();
      const { http } = scripted(discoveryDocument({ issuer }));
      const error = await discover(http).catch((e: unknown) => e);
      expect(error, String(issuer)).toBeInstanceOf(OAuthSetupError);
      expect(errorCodeOf(error)).toBe('A10');
      // Both values are in the message.
      expect((error as Error).message).toContain(JSON.stringify(ISSUER));
      if (typeof issuer === 'string') expect((error as Error).message).toContain(JSON.stringify(issuer));
    }
  });

  it('cuts a long issuer of the document short in the message', async () => {
    const { discover } = setup();
    const error = (await discover(scripted(discoveryDocument({ issuer: 'x'.repeat(5000) })).http).catch((e: unknown) => e)) as Error;
    expect(error.message.length).toBeLessThan(600);
  });

  it('hands back the endpoints as the document gave them, with the issuer, and the userinfo address only when it is asked for', async () => {
    const { discover } = setup(true);
    const found = await discover(scripted(discoveryDocument()).http);
    expect(found).toEqual({ endpoints: { authorizeUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/token`, issuer: ISSUER }, userinfoUrl: `${ISSUER}/userinfo` });
    // Without `userinfo`, a missing or bad address does not matter.
    const plain = await setup(false).discover(scripted(discoveryDocument({ userinfo_endpoint: undefined })).http);
    expect(plain.userinfoUrl).toBeUndefined();
  });

  it('answers as no document when it asked for userinfo and the document has no usable userinfo_endpoint', async () => {
    for (const userinfo_endpoint of [undefined, 'http://idp.example.com/userinfo', 'not a url', 7]) {
      const error = await setup(true).discover(scripted(discoveryDocument({ userinfo_endpoint })).http).catch((e: unknown) => e);
      expect(error, String(userinfo_endpoint)).toBeInstanceOf(OAuthHttpError);
    }
  });

  it('answers as no document for a document that is no object, and asks for 256 KiB at most, without a form', async () => {
    for (const document of [[], 'text', null, 7]) {
      const error = await setup().discover(scripted(document).http).catch((e: unknown) => e);
      expect(error, JSON.stringify(document)).toBeInstanceOf(OAuthHttpError);
    }
    const sent: unknown[] = [];
    await setup().discover({ json: async (url, init) => (sent.push({ url, init }), discoveryDocument()) });
    expect(sent).toEqual([{ url: DISCOVERY_URL, init: { maxBytes: 262144 } }]);
  });

  it('drops a document without usable endpoints at once, so that it is kept for ten seconds and not for an hour', async () => {
    for (const broken of [{ authorization_endpoint: undefined }, { token_endpoint: undefined }, { token_endpoint: 'http://idp.example.com/token' }, { authorization_endpoint: 'https://idp.example.com/a?state=x' }, { token_endpoint: 7 }]) {
      const { discover, clock } = setup();
      const { http, urls } = scripted(discoveryDocument(broken), discoveryDocument());
      const error = await discover(http).catch((e: unknown) => e);
      expect(error, JSON.stringify(broken)).toBeInstanceOf(OAuthHttpError);
      // The reason of the check stays in the cause, a fixed text without the address.
      expect(((error as OAuthHttpError).cause as { reason: string }).reason).toMatch(/^(authorizeUrl|tokenUrl): /);
      clock.freeze(NOW + 9_000);
      await expect(discover(http)).rejects.toBeInstanceOf(OAuthHttpError);
      clock.freeze(NOW + 11_000);
      expect((await discover(http)).endpoints.tokenUrl).toBe(`${ISSUER}/token`);
      expect(urls).toHaveLength(2);
    }
  });

  it('refuses an http token endpoint in production', async () => {
    const { oauth, http, logger } = oidcWithLogger(discoveryDocument({ token_endpoint: 'http://idp.example.com/token' }));
    expect(await oauth.redirect('idp')).toEqual({ ok: false, error: { kind: 'unavailable' } });
    http.assertSentCount(1);
    expect(logger.entries.join('\n')).toContain('tokenUrl: it must use https');
    // Nothing of the address is logged.
    expect(logger.entries.join('\n')).not.toContain('idp.example.com');
  });

  it('caches a discovery for an hour and fetches again after it', async () => {
    const { discover, clock } = setup();
    const { http, urls } = scripted(discoveryDocument());
    await discover(http);
    clock.freeze(NOW + 3_599_000);
    await discover(http);
    expect(urls).toHaveLength(1);
    clock.freeze(NOW + 3_600_000);
    await discover(http);
    expect(urls).toHaveLength(2);
  });

  it('keeps a failure for ten seconds and asks again after them', async () => {
    const { discover, clock } = setup();
    const { http, urls } = scripted(new OAuthHttpError(502), discoveryDocument());
    await expect(discover(http)).rejects.toBeInstanceOf(OAuthHttpError);
    clock.freeze(NOW + 9_000);
    await expect(discover(http)).rejects.toBeInstanceOf(OAuthHttpError);
    expect(urls).toHaveLength(1);
    clock.freeze(NOW + 10_000);
    expect((await discover(http)).endpoints.issuer).toBe(ISSUER);
    expect(urls).toHaveLength(2);
  });

  it('shares one request between parallel redirects', async () => {
    const { oauth, http } = oidcWithLogger(discoveryDocument());
    const results = await Promise.all([oauth.redirect('idp'), oauth.redirect('idp'), oauth.redirect('idp')]);
    expect(results.map((result) => result.ok)).toEqual([true, true, true]);
    http.assertSentCount(1);
  });

  it('shares a running request, and one failure, between callers', async () => {
    const { discover } = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { http, urls } = scripted(async () => {
      await held;
      throw new OAuthHttpError(503);
    });
    const calls = [discover(http), discover(http)];
    release();
    for (const call of calls) await expect(call).rejects.toBeInstanceOf(OAuthHttpError);
    expect(urls).toHaveLength(1);
  });
});

function oidcWithLogger(document: Record<string, unknown>, node = 'production') {
  const logger = recordingLogger();
  const made = oidcWith({}, { logger }, document, node);
  return { ...made, logger };
}
