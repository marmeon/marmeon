import { createMarmeonApp, progressBar } from '@marmeon/react';
import '@marmeon/react/styles.css'; // the framework's look: layers, dialogs, the error page (a stylesheet, no inline style)
import 'virtual:marmeon/fonts.css'; // the font's stand-in while it loads (vite.config.ts)
import { Confirm } from '../layouts/Confirm.tsx';
import { routes } from 'virtual:marmeon/routes';
import { title } from './head.ts';
import { messages } from './i18n.ts';
import { layer, layout } from './layouts.ts';
import { resolvePage } from './pages.ts';

// `confirm`: the app's dialog asks — before a link, an action or a form with `confirm`, and before unsaved changes are left.
// `progress`: the progress bar for visits slower than 250 ms (opt-in — an app without it carries none of its code).
// `viewTransition: 'react'`: each page change renders in a React transition with its direction — the views' <ViewTransition>
// animate (the avatar from the list into the profile, the page sliding by direction: styles/app.css); none under reduced motion.
void createMarmeonApp({ resolve: resolvePage, title, routes, layout, layer, messages, progress: progressBar({ delay: 250 }), confirm: Confirm, viewTransition: 'react' });
