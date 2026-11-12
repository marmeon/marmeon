/** The texts of the contact page — the source language. */
const en = {
  title: 'Contact',
  write_to: 'Write to {email}.',
  all_pages: 'All help pages',
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    support: typeof en;
  }
}
