import { createMarmeonApp, progressBar } from '@marmeon/react';
import '@marmeon/react/styles.css'; // the framework's look: layers, dialogs, the error page (a stylesheet, no inline style)
import { routes } from 'virtual:marmeon/routes';
import { title } from './head.ts';
import { layout } from './layouts.ts';
import { resolvePage } from './pages.ts';

void createMarmeonApp({ resolve: resolvePage, title, routes, layout, progress: progressBar({ delay: 250 }) });
