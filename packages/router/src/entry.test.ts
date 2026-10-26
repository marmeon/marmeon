import { describe, expect, it } from 'vitest';
import * as index from './index.ts';
import * as internal from './internal.ts';

describe('the entry points of @marmeon/router', () => {
  it('keeps the request pipeline out of the public entry', () => {
    for (const name of ['createRequestState', 'defaultToResponse', 'withQueuedCookies', 'clientIp', 'VALIDATE_HEADER', 'messageOf', 'NOT_LIVE']) {
      expect(index, name).not.toHaveProperty(name);
      expect(internal, name).toHaveProperty(name);
    }
  });

  it('does not export the helpers only the router uses', () => {
    for (const name of ['runPipeline', 'authorizeRequest', 'validateRequest', 'addsConflicts', 'joinPaths', 'queryInput', 'issueOfFields', 'nothingToValidate', 'attributeName', 'parseCookies', 'serializeCookie', 'createNonce']) expect(index, name).not.toHaveProperty(name);
  });

  it('keeps the URL helpers of the framework to the url entry', () => {
    for (const name of ['matchesPath', 'urlFor']) expect(index, name).not.toHaveProperty(name);
    expect(index).toHaveProperty('toSearchParams');
  });

  it('exports what an app writes against from the public entry', () => {
    for (const name of ['defineRoutes', 'defineMiddleware', 'defineRequest', 'Router', 'everyone']) expect(index, name).toHaveProperty(name);
  });
});
