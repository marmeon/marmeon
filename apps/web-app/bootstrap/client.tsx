import { createBespokeApp } from '@bespokecore/react';
import { resolvePage } from './pages.ts';

void createBespokeApp({ resolve: resolvePage });
