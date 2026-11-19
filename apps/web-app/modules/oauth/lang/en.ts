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
    session_ended: 'You were signed out meanwhile. Sign in and try again.',
    flow_failed: 'That did not work. Try again.',
    flow_cancelled: 'It was cancelled at the provider. Nothing has changed.',
    link_unavailable: 'That provider cannot be reached right now. Try again in a moment.',
    confirm_unavailable: 'That provider cannot be reached right now. Try again in a moment, or confirm another way.',
    linked: 'The account is connected.',
    link_confirm_first: 'Confirm it is you first, then connect the account again.',
    link_taken: 'That account is connected to another user here.',
    link_provider_linked: 'You have connected an account at this provider already. Remove it first to connect another.',
    link_email_unconfirmed: 'Confirm your e-mail address first, then connect the account.',
    link_invalid: 'That account cannot be connected. Try another one.',
    unlinked: 'The account is removed.',
    unlink_confirm_first: 'Confirm it is you first, then remove the account.',
    unlink_not_found: 'There is no such account to remove.',
    last_method: 'That is the only way you can sign in. Set a password or add another way first.',
    confirmed: 'Confirmed.',
    confirm_not_fresh: 'The provider did not confirm a fresh sign-in. Try again, or confirm another way.',
    confirm_not_linked: 'That is not an account connected to you. Confirm with one that is, or another way.',
    confirm_expired: 'The confirmation could not be used. Try again, or confirm another way.',
    confirm_unsupported: 'This provider cannot confirm that it is you. Confirm another way.',
  },
  accounts: {
    title: 'Connected accounts',
    intro: 'The accounts you can sign in with. Connecting or removing one asks you to confirm it is you first.',
    none: 'No account is connected yet.',
    connect: 'Connect {provider}',
    remove: 'Remove',
    removing: 'Remove {provider}?',
    connected_since: 'Connected {date}',
    confirm_title: 'Confirm it is you',
    confirmed: 'You confirmed it is you a moment ago. Connecting and removing accounts works now.',
    confirm_needed: 'Confirm it is you to connect or remove an account.',
    confirm_with: 'Confirm with {provider}',
    confirm_with_password: 'Confirm on the confirmation page',
    no_confirmation: 'You have no password, and none of your accounts can confirm it is you. Sign out and use "Forgot your password?" on the sign-in page to set one.',
  },
  confirm: {
    title: 'Or confirm with a connected account',
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
    linked: {
      subject: 'An account was connected to your account',
      preview: 'A {provider} account was connected to your {app} account',
      hello: 'Hello,',
      intro: 'a {provider} account{who} was connected to your {app} account on {time}.',
      who: ' ({account})',
      outro: 'If this was you, nothing more to do. If it was not, sign in, remove the account from your connected accounts and change your password: someone else has access to your account.',
    },
  },
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    oauth: typeof en;
  }
}
