import { createBespokeApp, progressBar } from '@bespokecore/react';
import { routes } from 'virtual:bespoke/routes';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { resolvePage } from './pages.ts';

// `progress`: the progress bar for visits slower than 250 ms (E82: opt-in — leave it out for none, or pass your own indicator).
void createBespokeApp({ resolve: resolvePage, title, routes, messages, progress: progressBar({ delay: 250 }) });
