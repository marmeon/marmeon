import { join } from 'node:path';
import { startServer } from '@bespokecore/server';
import { router } from './app.ts';

await startServer({
  router,
  root: join(import.meta.dirname, '..'),
  ssrEntry: 'bootstrap/ssr.tsx',
  port: Number(process.env.PORT ?? 3000),
});
