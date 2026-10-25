/** The texts of the public pages — the source language. */
const en = {
  title: 'About',
  intro: 'What the framework does, one page each.',
  updated: 'Updated {date}',
  features: {
    'typed-routes': { title: 'Typed routes', summary: 'Route names and parameters are checked by the compiler, in controllers and views alike.' },
    'instant-visits': { title: 'Instant visits', summary: 'A page shows its placeholder at once while the answer is on its way.' },
    'server-rendering': { title: 'Server rendering', summary: 'Every page arrives as markup and hydrates in the browser.' },
    translations: { title: 'Translations', summary: 'Texts live in language files per module, in the request’s language.' },
  },
  back: 'All features',
  language: 'Language',
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    about: typeof en;
  }
}
