/** The texts of the notes — the source language. `lang/de.ts` is checked against this file. */
const en = {
  nav: 'Notes',
  index: {
    title: 'Your notes',
    new: 'New note',
    empty: 'You have no notes yet.',
    pinned: 'Pinned',
    pin: 'Pin',
    unpin: 'Unpin',
    edit: 'Edit',
    delete: 'Delete',
    delete_title: 'Delete {name}?',
    delete_confirm: 'The note is gone for good.',
    pagination: 'Pages of notes',
    previous: 'Previous',
    next: 'Next',
    page: 'Page {page}',
  },
  form: {
    new_title: 'New note',
    edit_title: 'Edit note',
    title: 'Title',
    body: 'Note',
    save: 'Save',
    cancel: 'Back to your notes',
    unsaved: 'You have unsaved changes. Leave this page?',
  },
  flash: {
    created: 'Note saved.',
    updated: 'Note updated.',
    deleted: 'Note deleted.',
  },
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    notes: typeof en;
  }
}
