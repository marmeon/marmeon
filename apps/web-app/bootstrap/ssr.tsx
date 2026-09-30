import { createSsrRenderer } from '@bespokecore/react/server';
import { resolvePage } from './pages.ts';

export const render = createSsrRenderer(resolvePage);
