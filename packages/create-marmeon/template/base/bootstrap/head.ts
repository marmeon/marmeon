import type { TitleTemplate } from '@marmeon/react';

/** The app's name in the tab. create-marmeon wrote it here and into `index.html`; change it here. */
const APP = 'App';

/** Document titles: a page's `<Head title>` plus the app name. Shared by the client and SSR entries. */
export const title: TitleTemplate = (page) => (page ? `${page} — ${APP}` : APP);
