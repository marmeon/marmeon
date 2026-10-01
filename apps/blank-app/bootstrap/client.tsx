import { createBespokeApp } from '@bespokecore/react';
import { routes } from 'virtual:bespoke/routes';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { resolvePage } from './pages.ts';

void createBespokeApp({ resolve: resolvePage, title, routes, messages });
