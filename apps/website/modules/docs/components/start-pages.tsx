import type { ReactNode } from 'react';

/**
 * Where a newcomer begins: install, find the way around an app, answer a first request. The docs' start page shows them as cards.
 * `section` is the page's section in the navigation, `label` its title there (a test keeps both equal to `docs.config.ts`).
 */
export const START: readonly { path: string; section: string; label: string; description: ReactNode }[] = [
  {
    path: '/docs/installation',
    section: 'Getting Started',
    label: 'Installation',
    description: 'Node 26.10+, pnpm 12 and the starter kit. SQLite in a file, so no database server to set up.',
  },
  {
    path: '/docs/structure',
    section: 'Getting Started',
    label: 'Directory Structure',
    description: (
      <>
        A feature lives in <code>modules/&lt;name&gt;/</code> with its routes, controllers, views and tests.
      </>
    ),
  },
  {
    path: '/docs/routing',
    section: 'The Basics',
    label: 'Routing',
    description: 'Routes, their names, and how one type reaches the page.',
  },
];
