import { createSsrRenderer } from '@bespokecore/react/server';
import { title } from './head.ts';
import { resolvePage } from './pages.ts';
import { routes } from './routes.ts';

export const render = createSsrRenderer(resolvePage, { title, routes });
