import type { Messages } from '@marmeon/i18n/messages';
import type en from './en.ts';

export default {
  title: 'Über',
  intro: 'Was das Framework kann, je Seite eine Funktion.',
  updated: 'Aktualisiert am {date}',
  features: {
    'typed-routes': { title: 'Typisierte Routen', summary: 'Routennamen und Parameter prüft der Compiler, in Controllern und Views gleichermaßen.' },
    'instant-visits': { title: 'Sofortige Besuche', summary: 'Eine Seite zeigt sofort ihren Platzhalter, während die Antwort unterwegs ist.' },
    'server-rendering': { title: 'Server-Rendering', summary: 'Jede Seite kommt als Markup an und wird im Browser hydratisiert.' },
    translations: { title: 'Übersetzungen', summary: 'Texte stehen je Modul in Sprachdateien, in der Sprache der Anfrage.' },
  },
  back: 'Alle Funktionen',
} satisfies Messages<typeof en>;
