import { createMarmeonApp, progressBar } from '@marmeon/react';
// app.css first: the first stylesheet names the cascade layers' order (`@layer base, marmeon, kit;`), the framework's `marmeon` before the kit's `kit`.
import '../styles/app.css'; // the starter kit's look in the layer `kit`: tokens, base styles, the font (make:auth adds the auth module's classes after it)
import '@marmeon/react/styles.css'; // the framework's look: layers, dialogs, the error page (a stylesheet, no inline style)
import 'virtual:marmeon/fonts.css'; // the font's stand-in while it loads (vite.config.ts)
import { routes } from 'virtual:marmeon/routes';
import { Confirm } from '../layouts/Confirm.tsx';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { resolvePage } from './pages.ts';

// `progress`: the progress bar for visits slower than 250 ms (opt-in — leave it out for none, or pass your own indicator).
// `confirm`: the app's dialog asks — in the page's language: a link's, an action's or a form's `confirm`, and the question
// before unsaved changes are left (also when another tab signed in or out).
void createMarmeonApp({ resolve: resolvePage, title, routes, messages, progress: progressBar({ delayMs: 250 }), confirm: Confirm });
