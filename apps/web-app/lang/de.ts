import type { Messages } from '@bespokecore/i18n/messages';
import type en from './en.ts';

export default {
  name: 'BespokeCore',
  dashboard: 'Übersicht',
  account: 'Konto',
  profile: 'Dein Profil',
  settings: 'Einstellungen',
  sign_out: 'Abmelden',
  sign_in: 'Anmelden',
  register: 'Konto anlegen',
  close: 'Schließen',
  language: 'Sprache',
  locale: {
    changed: 'Sprache geändert.',
    unsupported: 'Diese Sprache gibt es nicht.',
  },
} satisfies Messages<typeof en>;
