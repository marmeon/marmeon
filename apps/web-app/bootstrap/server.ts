import { startServer } from '@bespokecore/server';
import { router } from './app.ts';

startServer({ router, port: Number(process.env.PORT ?? 3000) });
