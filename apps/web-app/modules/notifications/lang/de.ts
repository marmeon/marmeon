import type { Messages } from '@bespokecore/i18n/messages';
import type en from './en.ts';

export default {
  title: 'Benachrichtigungen',
  none: 'Keine Benachrichtigungen.',
  mark_read: 'Als gelesen markieren',
  mark_all_read: 'Alle als gelesen markieren',
  unread: 'Ungelesen',
  unknown: 'Eine Benachrichtigung',
  new_sign_in: {
    title: 'Neue Anmeldung bei deinem Konto',
    body: 'Von {ip} · {browser}',
  },
} satisfies Messages<typeof en>;
