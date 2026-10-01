import { createBespokeApp } from '@bespokecore/react';
import { title } from './head.ts';
import { resolvePage } from './pages.ts';
import { routes } from './routes.ts';

void createBespokeApp({ resolve: resolvePage, title, routes });
