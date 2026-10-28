import type { Messages } from '@marmeon/i18n/messages';
import type en from './en.ts';

export default {
  title: 'Benachrichtigungen',
  none: 'Keine Benachrichtigungen.',
  mark_read: 'Als gelesen markieren',
  mark_all_read: 'Alle als gelesen markieren',
  more: 'Mehr laden',
  delete: 'Löschen',
  confirm_delete: 'Diese Benachrichtigung löschen?',
  unread: 'Ungelesen',
  unknown: 'Eine Benachrichtigung',
  new_sign_in: {
    title: 'Neue Anmeldung bei deinem Konto',
    body: 'Von {ip} · {browser}',
  },
  mail: {
    digest: {
      subject: 'Deine Benachrichtigungen',
      intro: 'Du hast neue Benachrichtigungen.',
      unsubscribe: 'Diese Mails abbestellen',
      page_title: 'Diese Mails abbestellen?',
      page_body: 'Der Digest wird nicht mehr an {email} gesendet.',
      page_button: 'Mails abbestellen',
    },
  },
} satisfies Messages<typeof en>;
