import { createSsrRenderer } from '@marmeon/react/server';
import { routes } from 'virtual:marmeon/routes';
import { title } from './head.ts';
import { layout } from './layouts.ts';
import { resolvePage } from './pages.ts';

export const render = createSsrRenderer(resolvePage, { title, routes, layout });
