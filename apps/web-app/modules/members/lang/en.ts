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
  per_page: 'Per page',
  select_none: 'Clear the selection',
  apply: 'Apply',
  reset: 'Reset',
  // The live region: read out after every change of the list.
  count: '{total, plural, =0 {No members match.} one {# member} other {# members}}',
  sorted: '{total, plural, =0 {No members match.} one {# member} other {# members}}, sorted by {column} ({direction, select, asc {ascending} other {descending}})',
  page_of: ', page {page} of {lastPage}',
  removed: '{done, plural, =0 {No links removed} one {Links of # member removed} other {Links of # members removed}}{skipped, plural, =0 {} other {, # left out}}.',
  remove_failed: 'The links could not be removed — please try again.',
  locale_set: '{done, plural, =0 {No language changed} one {Language of # member changed} other {Language of # members changed}}{skipped, plural, =0 {} other {, # left out}}.',
  locale_set_failed: 'The language could not be changed — please try again.',
  set_locale_button: 'Set the language of the selected ({count}) to {locale, select, en {English} other {German}}',
  column: {
    name: 'Name',
    email: 'E-mail',
    joined: 'Joined',
    links: 'Links',
  },
  actions: 'Actions',
  remove_links: 'Remove links',
  remove_links_of: 'Remove links: {name}',
  confirm_remove: 'Remove every profile link of {name}?',
  select: 'Select {name}',
  select_page: 'Select every member on this page',
  bulk_remove: 'Remove the links of the selected ({count})',
  bulk_all: 'Remove the links of all {total} matching',
  confirm_bulk: '{count, plural, one {Remove the profile links of # member?} other {Remove the profile links of # members?}}',
  export: 'Download as CSV',
  import_file: 'Import members from a CSV file',
  import_uploading: 'Sending the file: {percent}%',
  import_ready: 'The file is ready.',
  import_save: 'Import',
  import_columns: 'The first row needs the columns name and email.',
  imported: '{rows, plural, one {# row} other {# rows}} read, {invalid, number} to correct.',
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    members: typeof en;
  }
}
