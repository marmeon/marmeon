import { createSsrRenderer } from '@marmeon/react/server';
import { routes } from 'virtual:marmeon/routes';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { resolvePage } from './pages.ts';

export const render = createSsrRenderer(resolvePage, { title, routes, messages });
