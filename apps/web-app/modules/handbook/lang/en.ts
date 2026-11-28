/** The texts of the handbook search — the source language. The articles and questions are rows, one per language. */
const en = {
  title: 'Search the handbook',
  search: 'Search',
  term: 'Search term',
  article: 'Article',
  faq: 'Question',
  none: 'Nothing found for “{term}”.',
  unavailable: 'Search is not available right now. Please try again later.',
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    handbook: typeof en;
  }
}
