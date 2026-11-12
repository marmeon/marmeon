/** The texts around the help pages — the source language. The pages themselves are in `HelpPages`, one catalog per language. */
const en = {
  title: 'Help',
  all_pages: 'All help pages',
  language: 'Language',
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    help: typeof en;
  }
}
