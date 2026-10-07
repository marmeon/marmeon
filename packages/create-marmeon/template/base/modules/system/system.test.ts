import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';

// A first test: the app boots and answers its health check. `pnpm test` runs every `modules/**/*.test.ts` (vitest.config.ts).
it('boots and answers GET /up', async () => {
  const app = await createTestApp(application);
  await app.get('/up').assertOk();
});
