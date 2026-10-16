import { tempDir } from '../../../scripts/test/temp-dir.js';
import { defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defineRoutes, HttpServiceProvider } from '@marmeon/http';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './index.ts';

describe('createTestApp — routes that do not say who may call them', () => {
  it('refuses to start, as the app would', async () => {
    await expect(
      createTestApp(
        {
          root: tempDir('marmeon-testing-'),
          discover: false,
          providers: [EncryptionServiceProvider, HttpServiceProvider],
          modules: [defineModule({ name: 'pages', routes: defineRoutes((Route) => Route.get('/about', () => 'about')) })],
        },
        { env: { APP_KEY: generateKey() } },
      ),
    ).rejects.toThrow(/do(es)? not say who may call/);
  });
});
