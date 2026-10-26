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
    for (const name of ['Controller', 'view', 'defineRoutes', 'SharedData', 'ReadOnlyError']) expect(index, name).toHaveProperty(name);
    expect(index).not.toHaveProperty('ReadOnlyViolation');
  });

  it('keeps the machinery the framework\'s packages share on the internal entry only', () => {
    const shared = [
      'CONNECTION_HEADER', 'LIVE_PATH', 'LiveSigner', 'DOCUMENT_HEADER', 'SESSION_PATH', 'INTENDED_KEY', 'OLD_INPUT_KEY', 'flashableInput',
      'jsonResponse', 'PageSession', 'AssetVersion', 'browserRoutes', 'staticView', 'Flasher', 'ReadOnly', 'ParentRequest', 'ServerClosing',
    ];
    for (const name of shared) {
      expect(index, name).not.toHaveProperty(name);
      expect(internal, name).toHaveProperty(name);
    }
  });

  it('exports no name that only the package itself uses', () => {
    const own = [
      'addFlash', 'addLive', 'carryLive', 'withLiveMethod', 'toLayer', 'compilePolicy', 'epochOfResolver', 'SessionEpoch', 'SessionEpochController',
      'TAB_SYNC_CHANNEL', 'LIVE_CHANNEL', 'mergeOf', 'propKind', 'resolveProp', 'ERRORS_KEY', 'httpSolutions', 'NO_CLIENT_INFO',
    ];
    for (const name of own) {
      expect(index, name).not.toHaveProperty(name);
      expect(internal, name).not.toHaveProperty(name);
    }
  });
});
