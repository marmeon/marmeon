import type { Messages } from '@marmeon/i18n/messages';
import type en from './en.ts';

/** Die Texte der Startseite auf Deutsch — ein fehlender Schlüssel oder Platzhalter ist ein Compilerfehler. */
export default {
  title: 'Willkommen',
  heading: 'Willkommen bei {app}',
  intro: 'Eine Marmeon-App: Diese Seite ist modules/home — ändere sie, oder lege mit marmeon make:module ein eigenes Modul an.',
  guest: 'Melde dich an oder lege ein Konto an, um loszulegen.',
  sign_in: 'Anmelden',
  register: 'Konto anlegen',
  signed_in: 'Angemeldet als {name}.',
  dashboard: 'Zu deinem Dashboard',
} satisfies Messages<typeof en>;
