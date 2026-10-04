import type { Messages } from '@bespokecore/i18n/messages';
import type en from './en.ts';

/** Die Texte des Frameworks auf Deutsch (Namensraum `bespoke`). */
export default {
  status: {
    '400': 'Ungültige Anfrage',
    '401': 'Nicht angemeldet',
    '403': 'Zugriff verweigert',
    '404': 'Nicht gefunden',
    '405': 'Methode nicht erlaubt',
    '413': 'Anfrage zu groß',
    '415': 'Nicht unterstütztes Format',
    '419': 'Seite abgelaufen',
    '422': 'Ungültige Eingabe',
    '423': 'Gesperrt',
    '429': 'Zu viele Anfragen',
    '500': 'Serverfehler',
    '503': 'Dienst nicht verfügbar',
  },
  errors: {
    unauthorized: 'Diese Aktion ist nicht erlaubt.',
    csrf: 'Die Seite ist abgelaufen. Bitte neu laden und noch einmal versuchen.',
    cross_site: 'Anfrage einer fremden Seite abgelehnt.',
    throttled: 'Zu viele Versuche.',
    signature: 'Ungültige Signatur.',
  },
  validation: {
    password: {
      required: 'Bitte ein Passwort eingeben.',
      min: 'Das Passwort braucht mindestens {min} Zeichen.',
      max: 'Das Passwort ist zu lang.',
    },
    confirmed: 'Die Passwörter stimmen nicht überein.',
    upload: {
      required: 'Bitte eine Datei wählen.',
      invalid: 'Die Datei ist nicht angekommen — bitte noch einmal wählen.',
      expired: 'Der Upload ist abgelaufen — bitte die Datei noch einmal wählen.',
      used: 'Diese Datei wurde schon gespeichert — bitte noch einmal wählen.',
      max: 'Die Datei darf höchstens {max} groß sein.',
      type: 'Dieser Dateityp ist nicht erlaubt (erlaubt: {types}).',
    },
    more: '(und {count, plural, one {# weiterer Fehler} other {# weitere Fehler}})',
  },
} satisfies Messages<typeof en>;
