import type { TitleTemplate } from '@marmeon/react';

/** Document titles: a page's `<Head title>` plus the app name. Shared by the client and SSR entries. */
export const title: TitleTemplate = (page) => (page ? `${page} — Marmeon` : 'Marmeon');
