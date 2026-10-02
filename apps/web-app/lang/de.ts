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
  action_failed:
    '{reason, select, signed_out {Du bist abgemeldet — lade die Seite neu, um dich wieder anzumelden.} expired {Deine Sitzung ist abgelaufen — lade die Seite neu.} offline {Der Server ist nicht erreichbar — versuch es noch einmal.} forbidden {Das darfst du nicht.} other {Das hat nicht geklappt — versuch es noch einmal.}}',
  locale: {
    changed: 'Sprache geändert.',
    unsupported: 'Diese Sprache gibt es nicht.',
  },
} satisfies Messages<typeof en>;
