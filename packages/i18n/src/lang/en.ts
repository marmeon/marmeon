import en from './texts.ts';

export default en;

// Apart from the texts: `FrameworkTexts` of the browser-safe core names their type, and must not bring the namespace into every
// app that imports it — an app that declares no messages of its own keeps plain string keys.
declare module '@marmeon/i18n/messages' {
  interface Translations {
    marmeon: typeof en;
  }
}
