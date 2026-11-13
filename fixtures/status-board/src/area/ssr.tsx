import { createSsrRenderer } from '@marmeon/react/server';
import { routes } from 'virtual:marmeon/routes';
import { messages } from './messages.ts';
import { resolvePage } from './pages.ts';

export const render = createSsrRenderer(resolvePage, { routes, messages });
