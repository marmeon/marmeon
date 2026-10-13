import type { Messages } from '@marmeon/i18n/messages';
import type en from './en.ts';

/** Die Texte der Startseite auf Deutsch — ein fehlender Schlüssel oder Platzhalter ist ein Compilerfehler. */
export default {
  title: 'Willkommen',
  heading: 'Willkommen bei {app}',
  intro: 'Eine Marmeon-App, bereit zum Weiterbauen. Anmeldung, Registrierung und Einstellungen sind schon da.',
  guest: 'Melde dich an oder lege ein Konto an, um loszulegen.',
  sign_in: 'Anmelden',
  register: 'Konto anlegen',
  signed_in: 'Angemeldet als {name}.',
  dashboard: 'Zu deinem Dashboard',
  next_steps: 'Nächste Schritte',
  edit_title: 'Diese Seite ändern',
  edit_page: 'Die Seite:',
  edit_look: 'Das Aussehen:',
  edit_module: 'Eine eigene Funktion:',
  docs_title: 'Die Doku lesen',
  docs_text: 'Wie eine App aufgebaut ist und wie du darauf aufbaust.',
  docs_installation: 'Installation',
  docs_structure: 'Struktur',
  kit_title: 'Über das Starter-Kit',
  kit_text: 'Was Anmeldung, Registrierung und Einstellungen mitbringen und wie du sie änderst.',
  kit_link: 'Das Starter-Kit',
  guide_title: 'Baue ein erstes Feature',
  guide_text: 'Eine Notizen-App auf dem Starter-Kit, Schritt für Schritt: ein Modul, eine Tabelle, Seiten und Tests.',
  guide_link: 'Deine erste App',
} satisfies Messages<typeof en>;
