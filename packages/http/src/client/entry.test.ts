import { describe, expect, it } from 'vitest';
import * as page from '../page.ts';
import * as adapter from './adapter.ts';
import * as client from './index.ts';

describe('the entries of the client core', () => {
  it('keeps what only a UI adapter builds on out of @marmeon/http/client', () => {
    for (const name of ['Navigator', 'defineFeature', 'Region', 'RegionOwner', 'readInitialPage', 'hasServerMarkup', 'loadHistoryFallback', 'formEntries', 'pageInfo', 'scriptJson']) {
      expect(client, name).not.toHaveProperty(name);
      expect(adapter, name).toHaveProperty(name);
    }
  });

  it('keeps what an app uses in @marmeon/http/client', () => {
    for (const name of ['xsrfToken', 'hooks', 'tabSync', 'createPoll', 'progressBar']) expect(client, name).toHaveProperty(name);
    expect(adapter).not.toHaveProperty('hooks');
    expect(adapter).not.toHaveProperty('tabSync');
  });

  it('keeps the features only an adapter attaches in @marmeon/http/client/adapter', () => {
    for (const name of ['actions', 'islands', 'layers', 'live', 'liveValidation', 'prefetch', 'optimistic', 'remember', 'guard', 'instant', 'revalidateOnBack', 'queryState', 'selection', 'uploads', 'viewTransitions', 'devtools']) {
      expect(client, name).not.toHaveProperty(name);
      expect(adapter, name).toHaveProperty(name);
    }
  });

  it('takes the page helpers an adapter needs out of @marmeon/http/page', () => {
    for (const name of ['pageInfo', 'pageName', 'scriptJson', 'matchesPath', 'ERROR_PAGE', 'LAYER_BACKDROP']) {
      expect(page, name).not.toHaveProperty(name);
      expect(adapter, name).toHaveProperty(name);
    }
  });
});
