import type { Messages } from '@marmeon/i18n/messages';
import type en from './en.ts';

/** Die Texte der Notizen auf Deutsch — ein fehlender Schlüssel oder Platzhalter ist ein Compilerfehler. */
export default {
  nav: 'Notizen',
  index: {
    title: 'Deine Notizen',
    new: 'Neue Notiz',
    empty: 'Du hast noch keine Notizen.',
    pinned: 'Angeheftet',
    pin: 'Anheften',
    unpin: 'Lösen',
    edit: 'Bearbeiten',
    delete: 'Löschen',
    delete_title: '{name} löschen?',
    delete_confirm: 'Die Notiz ist danach endgültig weg.',
    pagination: 'Seiten der Notizen',
    previous: 'Zurück',
    next: 'Weiter',
    page: 'Seite {page}',
  },
  form: {
    new_title: 'Neue Notiz',
    edit_title: 'Notiz bearbeiten',
    title: 'Titel',
    body: 'Notiz',
    save: 'Speichern',
    cancel: 'Zurück zu deinen Notizen',
    unsaved: 'Es gibt ungespeicherte Änderungen. Seite verlassen?',
  },
  flash: {
    created: 'Notiz gespeichert.',
    updated: 'Notiz aktualisiert.',
    deleted: 'Notiz gelöscht.',
  },
} satisfies Messages<typeof en>;
