import { startServer } from '@bespokecore/server';
import { AppConfig } from '../config/app.ts';
import { app } from './app.ts';

await startServer({
  app,
  ssrEntry: 'bootstrap/ssr.tsx',
  port: app.container.make(AppConfig).port,
});
