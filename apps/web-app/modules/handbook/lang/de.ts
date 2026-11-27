import type { Messages } from '@marmeon/i18n/messages';
import type en from './en.ts';

export default {
  title: 'Im Handbuch suchen',
  search: 'Suchen',
  term: 'Suchbegriff',
  article: 'Artikel',
  faq: 'Frage',
  none: 'Nichts gefunden für „{term}“.',
  unavailable: 'Die Suche ist gerade nicht erreichbar. Bitte versuche es später noch einmal.',
} satisfies Messages<typeof en>;
