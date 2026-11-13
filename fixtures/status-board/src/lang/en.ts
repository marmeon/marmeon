/** The texts of the area — the source language. */
const en = {
  title: 'Service status',
  intro: 'Every service the board watches, in a document of its own.',
  back: 'Back to the app',
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    status: typeof en;
  }
}
