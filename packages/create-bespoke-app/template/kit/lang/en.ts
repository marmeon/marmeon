/**
 * App-wide texts (namespace `app`) — the source language: the questions the app asks (`bootstrap/confirm.tsx`). Another
 * language is a file next to this one (`de.ts`), checked against it. Views read them with `useTranslation('app')`.
 */
const en = {
  confirm: {
    ok: 'OK',
    cancel: 'Cancel',
    leave: 'Leave',
    stay: 'Stay',
    prompt: 'Type “{text}” to confirm',
    // Another tab signed in or out, or switched the language (tab sync), while this one has unsaved changes.
    session: 'You signed in or out, or changed the language, in another tab. Load this page again? Your unsaved changes will be lost.',
    reload: 'Load again',
  },
} as const;

export default en;

declare module '@bespokecore/i18n/messages' {
  interface Translations {
    app: typeof en;
  }
}
