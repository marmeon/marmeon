import type { Messages } from '@marmeon/i18n/messages';
import type en from './en.ts';

export default {
  login: {
    title: 'Anmeldung im Back Office',
    heading: 'Back Office',
    intro: 'Nur für die Redaktion. Kunden melden sich in der App an.',
    email: 'E-Mail',
    password: 'Passwort',
    submit: 'Anmelden',
    submitting: 'Anmelden…',
    failed: 'Diese Zugangsdaten stimmen nicht.',
    throttled: 'Zu viele Anmeldeversuche. Versuche es in {seconds, plural, one {# Sekunde} other {# Sekunden}} erneut.',
    locked: 'Zu viele fehlgeschlagene Anmeldungen für dieses Konto. Versuche es später erneut.',
  },
  overview: {
    title: 'Back Office',
    greeting: 'Willkommen, {name}.',
    own: 'Du bist mit deinem Konto im Back Office angemeldet.',
    app: 'Du bist mit deinem Konto der App angemeldet.',
    publish: 'Veröffentlichen',
    readOnly: 'Du kannst ansehen, aber nicht veröffentlichen.',
    sessions: 'Deine Anmeldungen',
    secure: 'Geschützte Seite',
    logout: 'Abmelden',
  },
  sessions: {
    title: 'Deine Anmeldungen',
    current: 'dieser Browser',
    unknown: 'Unbekannter Browser',
    end: 'Abmelden',
    back: 'Zurück zum Back Office',
  },
  confirm: {
    title: 'Passwort bestätigen',
    intro: 'Diese Seite fragt noch einmal nach deinem Passwort im Back Office.',
    password: 'Passwort',
    submit: 'Bestätigen',
    incorrect: 'Das Passwort stimmt nicht.',
    throttled: 'Zu viele Versuche. Versuche es in {seconds, plural, one {# Sekunde} other {# Sekunden}} erneut.',
  },
  secure: {
    title: 'Geschützte Seite',
    intro: 'Das sehen nur Redakteure, die ihr Passwort gerade bestätigt haben.',
    back: 'Zurück zum Back Office',
  },
} satisfies Messages<typeof en>;
