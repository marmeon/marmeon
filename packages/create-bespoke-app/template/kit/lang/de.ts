import type { Messages } from '@bespokecore/i18n/messages';
import type en from './en.ts';

/** App-wide texts in German — checked against `en.ts`. */
export default {
  confirm: {
    ok: 'OK',
    cancel: 'Abbrechen',
    leave: 'Verlassen',
    stay: 'Bleiben',
    prompt: 'Gib „{text}“ ein, um zu bestätigen',
    // Ein anderer Tab hat an- oder abgemeldet oder die Sprache gewechselt (Tab-Sync), während dieser ungespeicherte Änderungen hat.
    session: 'Du hast dich in einem anderen Tab an- oder abgemeldet oder die Sprache gewechselt. Diese Seite neu laden? Deine ungespeicherten Änderungen gehen verloren.',
    reload: 'Neu laden',
  },
} satisfies Messages<typeof en>;
