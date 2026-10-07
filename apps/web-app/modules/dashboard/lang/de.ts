import type { Messages } from '@marmeon/i18n/messages';
import type en from './en.ts';

export default {
  title: 'Übersicht',
  intro: 'Jedes Feld ist eine Island: eine eigene Route mit eigenen Berechtigungen — mit der Seite gestreamt, das langsame zuletzt.',
  loading: 'Wird geladen …',
  sign_ins: {
    title: 'Letzte Anmeldungen',
    range: 'Zeitraum',
    range_option: '{range, select, 7d {7 Tage} 30d {30 Tage} other {Gesamt}}',
    none: 'In diesem Zeitraum hat sich niemand angemeldet.',
    edit: 'Profil bearbeiten',
  },
  activity: {
    title: 'Meine Aktivität',
    entry: '{kind, select, link {Link „{label}“ hinzugefügt} signed-in {Angemeldet} other {Beigetreten}}',
    none: 'Noch nichts.',
    refreshed: 'Stand {time}',
  },
  members: {
    title: 'Mitglieder',
    text: '{members, plural, one {# Mitglied} other {# Mitglieder}}, {verified} mit bestätigter Adresse',
    newest: 'Zuletzt beigetreten:',
    hidden: 'Die Mitgliederzahlen sehen nur Administratoren mit bestätigter Adresse.',
  },
  people: 'Alle Personen',
  members_table: 'Mitgliedertabelle',
} satisfies Messages<typeof en>;
