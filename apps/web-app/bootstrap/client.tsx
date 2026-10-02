import { createBespokeApp, progressBar } from '@bespokecore/react';
import { Confirm } from '../layouts/Confirm.tsx';
import { routes } from 'virtual:bespoke/routes';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { layer, layout } from './layouts.ts';
import { resolvePage } from './pages.ts';

// `confirm`: the app's dialog asks (E64) — before a link, an action or a form with `confirm`, and before unsaved changes are left.
// `progress`: the progress bar for visits slower than 250 ms (E82: opt-in — an app without it carries none of its code).
void createBespokeApp({ resolve: resolvePage, title, routes, layout, layer, messages, progress: progressBar({ delay: 250 }), confirm: Confirm });
