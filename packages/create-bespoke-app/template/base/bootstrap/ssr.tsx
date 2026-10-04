import { createSsrRenderer } from '@bespokecore/react/server';
import { routes } from 'virtual:bespoke/routes';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { resolvePage } from './pages.ts';

export const render = createSsrRenderer(resolvePage, { title, routes, messages });
