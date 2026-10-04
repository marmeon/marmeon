import type { DefaultLayout } from '@bespokecore/react';
import { DocsLayout } from '../layouts/DocsLayout.tsx';

/** The layout of every page (E35) — also of the error page, which renders without the navigation (a 404 has no route). */
export const layout: DefaultLayout = () => DocsLayout;
