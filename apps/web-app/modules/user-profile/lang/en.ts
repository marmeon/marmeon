/** The texts of the profile pages — the source language. */
const en = {
  show: {
    member_since: 'Member since {date}',
    last_signed_in: 'Last signed in:',
    never: 'never',
    own: 'This is your profile.',
    settings: 'Settings',
    verify: 'Please confirm your e-mail address — the link is in your inbox.',
    verify_again: 'Send it again',
    edit: 'Edit profile',
    activity: 'Recent activity',
    activity_loading: 'Loading activity…',
    activity_entry: '{kind, select, link {Added the link “{label}”} signed-in {Signed in} other {Joined}}',
    stats: 'Statistics',
    stats_loading: 'Loading statistics…',
    stats_text: '{links, plural, one {# link} other {# links}} · member {number} of {members}',
    links: 'Links',
    remove: 'Remove',
    remove_label: 'Remove {label}',
    add_label: 'Label',
    add_url: 'URL',
    add: 'Add link',
    others: 'Other people',
    filter: 'Filter by name',
    last_seen: 'last seen {when}',
    never_signed_in: 'never signed in',
    back: 'Back to my profile',
    more: 'Load more',
  },
  edit: {
    title: 'Edit profile',
    name: 'Name',
    bio: 'Bio',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
  },
  status: {
    saved: 'Profile saved.',
    link_added: 'Link added.',
    link_removed: 'Link removed.',
  },
  validation: {
    name_min: 'The name needs at least {requirement} characters.',
    bio_max: 'The bio may have at most {requirement} characters.',
    link_label: 'Give the link a label.',
    link_url: 'Enter a full URL.',
    link_scheme: 'Only http and https links.',
    own_profile: 'You can only change your own profile.',
  },
} as const;

export default en;

declare module '@bespokecore/i18n/messages' {
  interface Translations {
    'user-profile': typeof en;
  }
}
