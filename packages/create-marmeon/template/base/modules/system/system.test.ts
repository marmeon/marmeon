import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';

// A first test: the app boots and answers its health check. `pnpm test` runs every `modules/**/*.test.ts` (vitest.config.ts).
it('boots and answers GET /up', async () => {
  const app = await createTestApp(application);
  await app.get('/up').assertOk();
});

// A new app runs LIVE_DRIVER=database: its migration creates the table the driver needs, so readiness is green once migrated.
it('is ready with LIVE_DRIVER=database after the migrations ran', async () => {
  const app = await createTestApp(application, { env: { LIVE_DRIVER: 'database' }, database: 'refresh' });
  await app.get('/up/ready').assertOk();
});
