import type { Messages } from '@marmeon/i18n/messages';
import type en from './en.ts';

export default {
  continue_with: 'Weiter mit {provider}',
  messages: {
    unavailable: 'Dieser Anbieter ist gerade nicht erreichbar. Versuche es gleich noch einmal oder melde dich anders an.',
    cancelled: 'Die Anmeldung wurde abgebrochen. Es hat sich nichts geändert.',
    failed: 'Die Anmeldung hat nicht geklappt. Versuche es noch einmal oder melde dich anders an.',
    account_exists: 'Zu dieser Adresse gibt es schon ein Konto. Melde dich wie gewohnt an und verbinde den Anbieter danach in den Kontoeinstellungen.',
    registration_closed: 'Neue Konten lassen sich hier nicht über einen Anbieter anlegen. Melde dich mit einem Konto an, das du hast.',
    email_required: 'Der Anbieter hat keine E-Mail-Adresse mitgeteilt, die diese App braucht. Melde dich anders an.',
    email_unverified: 'Der Anbieter hat deine E-Mail-Adresse nicht bestätigt. Bestätige sie dort und versuche es erneut oder melde dich wie gewohnt an.',
    signed_in: 'Du bist bereits angemeldet.',
  },
  mail: {
    exists: {
      subject: 'Jemand hat deine Adresse zur Anmeldung benutzt',
      preview: 'Eine Anmeldung mit {provider} hat deine Adresse benutzt',
      hello: 'Hallo,',
      intro: 'jemand hat sich bei {app} mit einem {provider}-Konto angemeldet, das deine E-Mail-Adresse hat. {provider} hatte die Adresse nicht bestätigt, deshalb wurde nichts verknüpft und niemand angemeldet.',
      button: 'Anmelden',
      outro: 'Warst du das, melde dich wie gewohnt an und verbinde {provider} in den Kontoeinstellungen. Warst du es nicht, ignoriere diese Mail: Es hat sich nichts geändert.',
    },
  },
} satisfies Messages<typeof en>;
