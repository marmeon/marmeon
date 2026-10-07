import { createMarmeonApp, progressBar } from '@marmeon/react';
import '@marmeon/react/styles.css'; // the framework's look: layers, dialogs, the error page (E202 — a stylesheet, no inline style)
import { routes } from 'virtual:marmeon/routes';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { resolvePage } from './pages.ts';

// `progress`: the progress bar for visits slower than 250 ms (E82: opt-in — leave it out for none, or pass your own indicator).
void createMarmeonApp({ resolve: resolvePage, title, routes, messages, progress: progressBar({ delay: 250 }) });
