import { defineModule } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp } from './index.ts';

// An app without @marmeon/search: the loader answers as it does when the package is not installed.
vi.mock('./import-search.ts', () => ({ importSearch: async () => undefined }));

const missingMessage = 'app.search needs @marmeon/search, which the app does not have: install it with marmeon add search.';

describe('app.search without @marmeon/search', () => {
  it.each([
    ['by default', {}],
    ["with search: 'fake'", { search: 'fake' as const }],
  ])('starts the app and says the package is missing (%s)', async (_name, options) => {
    await using app = await createTestApp({ root: tempDir('marmeon-testing-search-missing-'), discover: false, modules: [defineModule({ name: 'no-search' })] }, options);
    expect(() => app.search).toThrow(new Error(missingMessage));
  });
});
