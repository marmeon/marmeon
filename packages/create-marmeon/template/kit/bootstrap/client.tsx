import { createMarmeonApp, progressBar } from '@marmeon/react';
import '@marmeon/react/styles.css'; // the framework's look: layers, dialogs, the error page (E202 — a stylesheet, no inline style)
import { routes } from 'virtual:marmeon/routes';
import { Confirm } from './confirm.tsx';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { resolvePage } from './pages.ts';

// `progress`: the progress bar for visits slower than 250 ms (E82: opt-in — leave it out for none, or pass your own indicator).
// `confirm`: the app's dialog asks (E64) — in the page's language: a link's, an action's or a form's `confirm`, and the question
// before unsaved changes are left (also when another tab signed in or out).
void createMarmeonApp({ resolve: resolvePage, title, routes, messages, progress: progressBar({ delay: 250 }), confirm: Confirm });
