import { describe, expect, it } from 'vitest';
import * as index from './index.ts';
import * as internal from './internal.ts';

describe('the entry points of @marmeon/http', () => {
  it('keeps the page building and the header constants out of the public entry', () => {
    for (const name of ['resolvePageProps', 'scriptJson', 'flashOf', 'signedLive', 'writeBrowserRoutes', 'PAGE_HEADER', 'LOCATION_HEADER', 'ERROR_PAGE']) {
      expect(index, name).not.toHaveProperty(name);
      expect(internal, name).toHaveProperty(name);
    }
  });

  it('exports what an app writes against from the public entry', () => {
    for (const name of ['Controller', 'view', 'defineRoutes', 'SharedData', 'DOCUMENT_HEADER']) expect(index, name).toHaveProperty(name);
  });
});
