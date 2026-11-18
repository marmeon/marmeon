/**
 * The texts of the oauth module — the source language. Another language is a file next to this one, checked against it
 * (`lang/de.ts` ships with the module, checked the same way).
 *
 * Views read them with `useTranslation('oauth')`, the server with `translator.get('oauth.…')`.
 */
const en = {
  continue_with: 'Continue with {provider}',
  messages: {
    unavailable: 'That provider cannot be reached right now. Try again in a moment, or sign in another way.',
    cancelled: 'The sign-in was cancelled. Nothing has changed.',
    failed: 'The sign-in did not work. Try again, or sign in another way.',
    account_exists: 'An account with this address exists already. Sign in the usual way, then connect the provider from your account settings.',
    registration_closed: 'New accounts cannot be created with a provider here. Sign in with an account you have.',
    email_required: 'The provider shared no e-mail address, and this app needs one. Sign in another way.',
    email_unverified: 'The provider has not verified your e-mail address. Verify it there and try again, or sign in the usual way.',
    signed_in: 'You are signed in already.',
  },
  mail: {
    exists: {
      subject: 'Someone used your address to sign in',
      preview: 'A sign-in with {provider} used your address',
      hello: 'Hello,',
      intro: 'someone signed in to {app} with a {provider} account that has your e-mail address. {provider} had not verified the address, so nothing was linked and nobody was signed in.',
      button: 'Sign in',
      outro: 'If that was you, sign in the usual way and connect {provider} from your account settings. If it was not, ignore this mail: nothing has changed.',
    },
  },
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    oauth: typeof en;
  }
}
