import type { FrameworkTexts, MessageOverrides } from '@marmeon/i18n/messages';

/** Rewords the framework's German texts (namespace `marmeon`); every text not named here stays the framework's. */
export default {
  status: {
    '404': 'Seite nicht gefunden',
  },
} satisfies MessageOverrides<FrameworkTexts>;
