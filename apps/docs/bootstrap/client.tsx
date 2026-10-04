import { createBespokeApp, progressBar } from '@bespokecore/react';
import { routes } from 'virtual:bespoke/routes';
import { title } from './head.ts';
import { layout } from './layouts.ts';
import { resolvePage } from './pages.ts';

void createBespokeApp({ resolve: resolvePage, title, routes, layout, progress: progressBar({ delay: 250 }) });
