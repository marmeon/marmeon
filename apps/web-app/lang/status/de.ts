import type en from '@fixtures/status-board/lang/en';
import type { MessageOverrides } from '@marmeon/i18n/messages';

/** Rewords the status board package's German texts (namespace `status`); every text not named here stays the package's. */
export default {
  title: 'Systemzustand',
} satisfies MessageOverrides<typeof en>;
