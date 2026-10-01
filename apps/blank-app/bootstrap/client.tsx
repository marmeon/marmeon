import { createBespokeApp } from '@bespokecore/react';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { resolvePage } from './pages.ts';
import { routes } from './routes.ts';

void createBespokeApp({ resolve: resolvePage, title, routes, messages });
