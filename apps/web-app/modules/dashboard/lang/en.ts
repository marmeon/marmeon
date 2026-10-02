/** The texts of the dashboard — the source language. */
const en = {
  title: 'Dashboard',
  intro: 'Each panel is an island: a route of its own, with its own permissions — streamed with the page, the slow one last.',
  loading: 'Loading…',
  sign_ins: {
    title: 'Recent sign-ins',
    range: 'Time range',
    range_option: '{range, select, 7d {7 days} 30d {30 days} other {All time}}',
    none: 'Nobody signed in in this time.',
  },
  activity: {
    title: 'My activity',
    entry: '{kind, select, link {Added the link “{label}”} signed-in {Signed in} other {Joined}}',
    none: 'Nothing yet.',
    refreshed: 'As of {time}',
  },
  members: {
    title: 'Members',
    text: '{members, plural, one {# member} other {# members}}, {verified} with a confirmed address',
    newest: 'Newest:',
    hidden: 'Only administrators with a confirmed address see the member numbers.',
  },
  people: 'All people',
} as const;

export default en;

declare module '@bespokecore/i18n/messages' {
  interface Translations {
    dashboard: typeof en;
  }
}
