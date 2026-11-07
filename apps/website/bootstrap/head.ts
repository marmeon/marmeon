import type { TitleTemplate } from '@marmeon/react';

/** The home page's title; the template passes it through unchanged. */
export const HOME_TITLE = 'Marmeon — Full-stack TypeScript framework for Node.js';

/** Document titles: a page's `<Head title>` plus the website's name. Shared by the client and SSR entries. */
export const title: TitleTemplate = (page) => (page === HOME_TITLE ? page : page ? `${page} — Marmeon` : 'Marmeon');
