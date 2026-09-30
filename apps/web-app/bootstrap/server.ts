import { startServer } from '@bespokecore/server';
import { app } from './app.ts';

await startServer({
  app,
  ssrEntry: 'bootstrap/ssr.tsx',
  port: Number(process.env.PORT ?? 3000),
});
