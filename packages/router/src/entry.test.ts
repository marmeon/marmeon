import { describe, expect, it } from 'vitest';
import * as index from './index.ts';
import * as internal from './internal.ts';

describe('the entry points of @marmeon/router', () => {
  it('keeps the request pipeline out of the public entry', () => {
    for (const name of ['runPipeline', 'createRequestState', 'authorizeRequest', 'validateRequest', 'defaultToResponse', 'withQueuedCookies', 'clientIp', 'VALIDATE_HEADER']) {
      expect(index, name).not.toHaveProperty(name);
      expect(internal, name).toHaveProperty(name);
    }
  });

  it('exports what an app writes against from the public entry', () => {
    for (const name of ['defineRoutes', 'defineMiddleware', 'defineRequest', 'Router', 'everyone']) expect(index, name).toHaveProperty(name);
  });
});
