import { createMarmeonApp, progressBar } from '@marmeon/react';
import { routes } from 'virtual:marmeon/routes';
import { title } from './head.ts';
import { layout } from './layouts.ts';
import { resolvePage } from './pages.ts';

void createMarmeonApp({ resolve: resolvePage, title, routes, layout, progress: progressBar({ delay: 250 }) });
