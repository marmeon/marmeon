import type { TitleTemplate } from '@bespokecore/react';

/** Document titles: a page's `<Head title>` plus the site's name. Shared by the client and SSR entries. */
export const title: TitleTemplate = (page) => (page ? `${page} — BespokeCore docs` : 'BespokeCore docs');
