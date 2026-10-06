/** The texts of the members table — the source language. */
const en = {
  title: 'Members',
  intro: 'Everyone with a confirmed address. Administrators also see e-mail addresses, remove profile links and download the list.',
  caption: 'Members — sortable by the links in the column headings',
  search: 'Search members',
  locale: 'Language',
  locale_option: '{locale, select, en {English} de {German} other {Any}}',
  joined_from: 'Joined from',
  joined_to: 'Joined until',
  apply: 'Apply',
  reset: 'Reset',
  // The live region: read out after every change of the list.
  count: '{total, plural, =0 {No members match.} one {# member} other {# members}}',
  sorted: '{total, plural, =0 {No members match.} one {# member} other {# members}}, sorted by {column} ({direction, select, asc {ascending} other {descending}})',
  column: {
    name: 'Name',
    email: 'E-mail',
    joined: 'Joined',
    links: 'Links',
  },
  sort_by: 'Sort by {column}',
  actions: 'Actions',
  remove_links: 'Remove links',
  remove_links_of: 'Remove the links of {name}',
  confirm_remove: 'Remove every profile link of {name}?',
  select: 'Select {name}',
  select_page: 'Select every member on this page',
  bulk_remove: 'Remove the links of the selected ({count})',
  bulk_all: 'Remove the links of all {total} matching',
  confirm_bulk: '{count, plural, one {Remove the profile links of # member?} other {Remove the profile links of # members?}}',
  export: 'Download as CSV',
  none: 'No members match.',
} as const;

export default en;

declare module '@bespokecore/i18n/messages' {
  interface Translations {
    members: typeof en;
  }
}
