import { view, type PageObject } from '@marmeon/http';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import type { RouteLookup } from '@marmeon/router/internal';
import { describe, expect, it } from 'vitest';
import { createResponseFactory } from './render.ts';

const lookup = (unprefixedLocale: string | undefined, locales: readonly string[] | undefined): RouteLookup => ({ findByName: () => undefined, unprefixedLocale, locales });
const pageOf = async (routes: RouteLookup | undefined) => {
  const request = new Request('http://app.test/x', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
  const response = await createResponseFactory(undefined, routes)(view('x/Show', {}), { request } as never, undefined);
  return (await response.json()) as PageObject;
};

describe('the page object’s urlLocales', () => {
  it('is the router’s locale without a prefix and its locales', async () => {
    expect((await pageOf(lookup('de', ['en', 'de']))).urlLocales).toEqual({ unprefixed: 'de', supported: ['en', 'de'] });
  });

  it('is left out when the locales are not known, or none has no prefix, or there is no router', async () => {
    for (const routes of [lookup('de', undefined), lookup(undefined, ['en', 'de']), undefined]) {
      expect('urlLocales' in (await pageOf(routes))).toBe(false);
    }
  });
});
