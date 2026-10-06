import { createBespokeApp, progressBar } from '@bespokecore/react';
import { routes } from 'virtual:bespoke/routes';
import { Confirm } from './confirm.tsx';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { resolvePage } from './pages.ts';

// `progress`: the progress bar for visits slower than 250 ms (E82: opt-in — leave it out for none, or pass your own indicator).
// `confirm`: the app's dialog asks (E64) — in the page's language: a link's, an action's or a form's `confirm`, and the question
// before unsaved changes are left (also when another tab signed in or out).
void createBespokeApp({ resolve: resolvePage, title, routes, messages, progress: progressBar({ delay: 250 }), confirm: Confirm });
