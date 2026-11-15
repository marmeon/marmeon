import { createMarmeonApp } from '@marmeon/react';
import '@marmeon/react/styles.css';
import { routes } from 'virtual:marmeon/routes';
import { messages } from './messages.ts';
import { resolvePage } from './pages.ts';

void createMarmeonApp({ resolve: resolvePage, routes, messages });
