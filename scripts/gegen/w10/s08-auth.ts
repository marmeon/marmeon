import { defineGegenproben } from '../define.ts';

/**
 * W10.8 — auth leftovers (E203) and small security items (E204; the traceparent decided by Max, 07.10.).
 *
 * Unconfirmed accounts: without the schedule entry they stay (G1 web app; G1b the stub's command through the make:auth fixture — the
 * stub schedules nothing since E209). What is
 * deleted is decided by two conditions — the deadline and the missing confirmation — each with its own scenario (masking pair
 * G2 ↔ G3: a confirmed old account and an unconfirmed young one), never what was confirmed once — `first_verified_at` (Max, 07.10.;
 * G12 ↔ G3: each condition with its own account, G13/G13b: the link keeps the first confirmation — X13: changeEmail's coalesce
 * covers a link without it once the address changes, W10 step 9c) —, by the delete itself again
 * (G2b ↔ X2b: the look-up's condition hides a delete without its own — only a race shows it), counted from the sign-up (G2c). What goes with the account:
 * its sessions (G4), its reset token (G5), its avatar after the commit (G6, G6b).
 *
 * CSRF on demand: a guest's page draws no token (G7) — X7 shows the 419 check alone never sees it (the check is unchanged either
 * way: masking probe); a session without a token matches nothing (G7b); a kept session's page and cookie get the token made then
 * (G7c, G7d).
 *
 * Small items: a URL object in the log (G8, G8b), a caller's traceparent continued (G9) ↔ the opt-in continues (G9c), the link
 * (G9b), `uploads:prune --hours=0` (G10), a cursor of another list (G11 the name in the context, G11b the table, G11c the inbox).
 */
const WEB_REPO = 'apps/web-app/modules/auth/UserRepository.ts';
const WEB_DELETION = 'apps/web-app/modules/auth/AccountDeletion.ts';
const webPrune = (name: string) => ({ vitest: 'apps/web-app/modules/auth/prune-unverified.test.ts', name }) as const;
const pruneAll = webPrune('deletes the account with everything that is its');
const DELETE_CONDITIONS = "query = query.where('email_verified_at', 'is', null).where('first_verified_at', 'is', null).where('created_at', '<=', at);";
const MARK_VERIFIED = ".set({ email_verified_at: now, first_verified_at: sql<Date>`coalesce(first_verified_at, ${now.toISOString()})`, updated_at: now })";
const firstConfirmation = webPrune('the first confirmation is kept for good');
const linkRecords = webPrune('the verification link records the first confirmation itself');
const SESSION = 'packages/session/src/session.ts';
const LAZY = '    this.#started = true;\n    // No CSRF token yet (E203)';
const csrf = (name: string) => ({ vitest: 'packages/session/src/csrf.test.ts', name }) as const;
const TRACE = 'packages/otel/src/tracer.ts';
const TRUST = '    if (options.trustTraceparent) return';
const otel = (name: string) => ({ vitest: 'packages/otel/src/otel.test.ts', name }) as const;

export default defineGegenproben({
  step: 'W10.8',
  cases: [
    // --- E203: unconfirmed accounts -------------------------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'no schedule entry in the web app: the old unconfirmed account stays — nothing runs at 03:20',
      patch: [{ file: 'apps/web-app/modules/auth/schedule.ts', find: "  s.command('auth:prune-unverified').daily().at('03:20').timezone('Europe/Berlin').onOneServer();\n", replace: '' }],
      run: pruneAll,
      expect: /expected undefined to match object \{ outcome: 'ran' \}/,
    },
    {
      // Since E209 (W10 step 9c follow-up) the stub schedules no deletion — the app turns the line on —, so its measure is the command:
      // without its delete the generated app's test fails (before: the schedule line taken out).
      id: 'G1b',
      title: "the stub's command deletes nothing: the generated app's test fails — the make:auth fixture names it",
      patch: [
        {
          file: 'packages/auth/stubs/react/modules/auth/commands/PruneUnverifiedCommand.ts',
          find: 'const deleted = ids.length === 0 ? 0 : (await this.#accounts.delete(ids, { unconfirmedSince: since })).length;',
          replace: 'const deleted = ids.length === 0 ? 0 : (await this.#accounts.delete([], { unconfirmedSince: since })).length;',
        },
      ],
      run: { vitest: 'packages/auth/src/make-auth.test.ts', name: 'working auth area', timeout: 15 * 60_000 },
      expect: /generated tests failed: .*modules\/auth\/prune-unverified\.test\.ts > pruning accounts whose address was never confirmed — the default > deletes one older than 7 days/,
    },
    {
      id: 'G2',
      title: 'without the deadline (look-up and delete): an account unconfirmed for 5 days is deleted',
      patch: [
        { file: WEB_REPO, find: "      .where('first_verified_at', 'is', null)\n      .where('created_at', '<=', at)\n", replace: "      .where('first_verified_at', 'is', null)\n" },
        { file: WEB_REPO, find: DELETE_CONDITIONS, replace: "query = query.where('email_verified_at', 'is', null).where('first_verified_at', 'is', null);" },
      ],
      run: pruneAll,
      expect: /an account unconfirmed for 5 days was deleted: expected undefined to be defined/,
      masks: 'G3',
    },
    {
      id: 'G3',
      title: 'without the missing confirmation (look-up and delete): an account confirmed by email_verified_at alone is deleted',
      patch: [
        { file: WEB_REPO, find: "      .where('email_verified_at', 'is', null)\n      .where('first_verified_at', 'is', null)\n", replace: "      .where('first_verified_at', 'is', null)\n" },
        { file: WEB_REPO, find: DELETE_CONDITIONS, replace: "query = query.where('first_verified_at', 'is', null).where('created_at', '<=', at);" },
      ],
      run: pruneAll,
      expect: /a confirmed account without first_verified_at was deleted: expected undefined to be defined/,
      masks: 'G12',
    },
    {
      id: 'G12',
      title: 'without first_verified_at (look-up and delete): an account confirmed once, now with an unconfirmed address, is deleted',
      patch: [
        { file: WEB_REPO, find: "      .where('email_verified_at', 'is', null)\n      .where('first_verified_at', 'is', null)\n", replace: "      .where('email_verified_at', 'is', null)\n" },
        { file: WEB_REPO, find: DELETE_CONDITIONS, replace: "query = query.where('email_verified_at', 'is', null).where('created_at', '<=', at);" },
      ],
      run: pruneAll,
      expect: /an account confirmed once was deleted: expected undefined to be defined/,
      masks: 'G3',
    },
    {
      id: 'G13',
      title: 'the verification link does not record the first confirmation: first_verified_at stays empty after the link',
      patch: [{ file: WEB_REPO, find: MARK_VERIFIED, replace: '.set({ email_verified_at: now, updated_at: now })' }],
      run: linkRecords,
      expect: /the link did not record the first confirmation: expected null not to be null/,
      masks: 'G12',
    },
    {
      // Since W10 step 9b changeEmail() keeps a confirmation itself (coalesce) — G13's old scenario (confirmed, then changed) stayed
      // green without the link's write; found by the acceptance in a fresh worktree (W10 step 9c). The coalesce alone: s09b G4.
      id: 'X13',
      title: "masking probe: the same link without its write — confirmed, then changed, the account is kept (changeEmail's coalesce covers it)",
      patch: [{ file: WEB_REPO, find: MARK_VERIFIED, replace: '.set({ email_verified_at: now, updated_at: now })' }],
      run: firstConfirmation,
      expectGreen: true,
    },
    {
      id: 'G13b',
      title: 'a second confirmation overwrites the first one\'s time (no coalesce)',
      patch: [{ file: WEB_REPO, find: MARK_VERIFIED, replace: '.set({ email_verified_at: now, first_verified_at: now, updated_at: now })' }],
      run: firstConfirmation,
      expect: /to deeply equal/,
    },
    {
      id: 'G2b',
      title: "the delete without its own conditions (the look-up's hide it): an account confirmed between look-up and delete goes",
      patch: [{ file: WEB_REPO, find: DELETE_CONDITIONS, replace: 'query = query;' }],
      run: webPrune('decides again when it deletes'),
      expect: /an account confirmed meanwhile was deleted: expected \[ \{/,
    },
    {
      id: 'X2b',
      title: "masking probe: the same delete without conditions — the nightly run stays green (the look-up's conditions cover it)",
      patch: [{ file: WEB_REPO, find: DELETE_CONDITIONS, replace: 'query = query;' }],
      run: pruneAll,
      expectGreen: true,
    },
    {
      id: 'G2c',
      title: 'the deadline counted from the last change again: a never confirmed account of 40 days, touched 3 days ago, stays',
      patch: [
        { file: WEB_REPO, find: "      .where('created_at', '<=', at)\n", replace: "      .where(sql<string>`coalesce(updated_at, created_at)`, '<=', at)\n" },
        { file: WEB_REPO, find: DELETE_CONDITIONS, replace: "query = query.where('email_verified_at', 'is', null).where('first_verified_at', 'is', null).where(sql<string>`coalesce(updated_at, created_at)`, '<=', at);" },
      ],
      run: pruneAll,
      expect: /a never confirmed account of 40 days was kept: an update extended its days: expected \{/,
    },
    {
      id: 'G4',
      title: "the deletion leaves the account's sessions in the database store",
      patch: [{ file: WEB_DELETION, find: '    for (const user of deleted) await this.#sessions.end(user.id);\n', replace: '' }],
      run: pruneAll,
      expect: /the deleted account kept its sessions: expected \[ '\d+', '\d+' \] to deeply equal \[ '\d+' \]/,
    },
    {
      id: 'G5',
      title: "the deletion leaves the account's password reset token",
      patch: [{ file: WEB_DELETION, find: '        await this.#resets.forget(user.email);\n', replace: '' }],
      run: pruneAll,
      expect: /the deleted account kept its reset token: expected \[ '(kept|old)@example\.com', …\(1\) \] to deeply equal \[ 'kept@example\.com' \]/,
    },
    {
      id: 'G6',
      title: 'the user-profile module does not listen: the avatar file of the deleted account stays',
      patch: [{ file: 'apps/web-app/modules/user-profile/index.ts', find: ', listen(AccountDeleted, DeleteAvatar)', replace: '' }],
      run: pruneAll,
      expect: /Expected no "avatars\/old\.png" on the disk "public"\./,
    },
    {
      id: 'G6b',
      title: 'the avatar deleted at once, not after the commit: a deletion that rolls back has lost the picture',
      patch: [{ file: 'apps/web-app/modules/user-profile/listeners/DeleteAvatar.ts', find: "    await afterCommit(() => this.#storage.disk('public').delete(path).catch(() => false));", replace: "    void afterCommit;\n    await this.#storage.disk('public').delete(path);" }],
      run: webPrune('a deletion that fails keeps everything'),
      expect: /Expected "avatars\/old\.png" on the disk "public"\. It has: nothing\./,
    },

    // --- E203: the CSRF token on demand -------------------------------------------------------------------------------------------------
    {
      id: 'G7',
      title: "every new session draws a token at start again: a guest's page makes one",
      patch: [{ file: SESSION, find: LAZY, replace: "    this.#started = true;\n    if (typeof this.#data[TOKEN] !== 'string') this.#ensureToken();\n    // No CSRF token yet (E203)" }],
      run: csrf('draws no token at all'),
      expect: /a guest page drew a CSRF token: expected '[\w-]+…?' to be undefined/,
      masks: 'X7',
    },
    {
      id: 'X7',
      title: 'masking probe: the same eager token — a post without a token is still refused (the check never shows it)',
      patch: [{ file: SESSION, find: LAZY, replace: "    this.#started = true;\n    if (typeof this.#data[TOKEN] !== 'string') this.#ensureToken();\n    // No CSRF token yet (E203)" }],
      run: csrf('refuses a post without token with 419'),
      expectGreen: true,
    },
    {
      id: 'G7b',
      title: 'a session without a token compared as the empty string: `_token=` passes the check',
      patch: [{ file: 'packages/session/src/csrf.ts', find: "return typeof field === 'string' && token !== undefined && constantTimeEquals(field, token);", replace: "return typeof field === 'string' && constantTimeEquals(field, token ?? '');" }],
      run: csrf('draws no token at all'),
      expect: /expected 200 to be 419/,
    },
    {
      id: 'G7c',
      title: "the XSRF-TOKEN cookie of a kept session without making its token: the cookie is not the page's token",
      patch: [{ file: 'packages/session/src/csrf.ts', find: 'ctx.cookies.set(XSRF_COOKIE, this.#session.token(), {', replace: "ctx.cookies.set(XSRF_COOKIE, this.#session.currentToken() ?? '', {" }],
      run: csrf('a kept session whose request never asked for the token'),
      expect: /the XSRF-TOKEN cookie of a kept session carries no token: expected '' to match/,
    },
    {
      id: 'G7d',
      title: "a kept session's page without making its token: the page carries none",
      patch: [{ file: 'packages/session/src/provider.ts', find: 'session.readOnly ? session.currentToken() : session.token()', replace: 'session.currentToken()' }],
      run: csrf('a page whose request keeps the session carries the token'),
      expect: /the page of a kept session carries no token/,
    },

    // --- E204: small items -------------------------------------------------------------------------------------------------------------------
    {
      id: 'G8',
      title: 'a URL object on the log path written as it is: its token reaches the log',
      patch: [{ file: 'packages/core/src/redact.ts', find: '    if (value instanceof URL || value instanceof URLSearchParams) return this.text(String(value));\n', replace: '' }],
      run: { vitest: 'packages/core/src/redact.test.ts', name: 'are masked like text on the log path' },
      expect: /reset-password\/Q7mZ2xLk9TcV4bN8rW1yH6sD3fG5jA0pE2uI7oK9qMz\?email=ada%40example\.com&token=t0k3n-abc&page=2: expected/,
    },
    {
      id: 'G8b',
      title: "a URL object in the Redactor's value: an empty object instead of the masked URL",
      patch: [{ file: 'packages/core/src/redact.ts', find: '    if (value instanceof URL) return this.url(value.href);\n', replace: '' }],
      run: { vitest: 'packages/core/src/redact.test.ts', name: 'are masked by the Redactor too' },
      expect: /expected \{\} to be 'https:\/\/example\.com\/reset-password\/\[r/,
    },
    {
      id: 'G9',
      title: "a caller's traceparent continued by default: its sampled flag (00) switches the request's tracing off",
      patch: [{ file: TRACE, find: TRUST, replace: '    if (options.trustTraceparent || headers) return' }],
      run: otel('starts a trace of its own for every request'),
      expect: /the request was not recorded: the caller's sampled flag decided/,
      masks: 'G9c',
    },
    {
      id: 'G9c',
      title: 'the opt-in ignored: OTEL_TRUST_TRACEPARENT=true does not continue the trace',
      patch: [{ file: TRACE, find: TRUST, replace: '    if (options.trustTraceparent && !headers) return' }],
      run: otel('continues an incoming trace with OTEL_TRUST_TRACEPARENT=true'),
      expect: /to be '0af7651916cd43dd8448eb211c80319c'/,
      masks: 'G9',
    },
    {
      id: 'G9b',
      title: "the caller's context dropped instead of linked: the server span has no link",
      patch: [{ file: TRACE, find: 'links: caller && api.isSpanContextValid(caller) ? [{ context: caller }] : undefined };', replace: 'links: undefined };' }],
      run: otel('starts a trace of its own for every request'),
      expect: /expected \[\] to deeply equal \[ \[ …\(2\) \] \]/,
    },
    {
      id: 'G10',
      title: 'uploads:prune --hours=0 without the guard: it deletes uploads whose token still works',
      patch: [{ file: 'packages/storage/src/uploads/commands.ts', find: '    if (hours * 60 < lifetime && options.force !== true) {', replace: '    if (hours * 60 < lifetime && options.force !== true && false) {' }],
      run: { vitest: 'apps/web-app/modules/user-profile/avatar.test.ts', name: 'below UPLOADS_LIFETIME refuses without --force' },
      expect: /expected \+?0 to be 1/,
    },
    {
      id: 'G11',
      title: "the list's name left out of the cursor's context: another list's cursor with the same order decrypts",
      patch: [{ file: 'packages/database/src/pagination.ts', find: 'return name === undefined ? `${CURSOR_CONTEXT}:${order}` :', replace: 'return name === undefined || true ? `${CURSOR_CONTEXT}:${order}` :' }],
      run: { vitest: 'packages/database/src/pagination.test.ts', name: 'a named list takes only its own cursors' },
      expect: /promise resolved .* instead of rejecting/,
    },
    {
      id: 'G11b',
      title: "a table without its name: the feed's cursor works for another table with the same order",
      patch: [{ file: 'packages/table/src/tables.ts', find: '        name: `table:${definition.name}`,\n', replace: '' }],
      run: { vitest: 'packages/table/src/table.test.ts', name: 'pages by an encrypted cursor when asked to' },
      expect: /another table's cursor was taken: expected 200 to be 400/,
    },
    {
      id: 'G11c',
      title: "an inbox without its recipient's name: Ada's cursor pages Alan's notifications",
      patch: [{ file: 'packages/notifications/src/store.ts', find: "direction: 'desc', encrypter, name });", replace: "direction: 'desc', encrypter });" }],
      run: { vitest: 'packages/notifications/src/notifications.test.ts', name: "pages through the recipient's own notifications" },
      expect: /promise resolved .* instead of rejecting/,
    },
  ],
});
