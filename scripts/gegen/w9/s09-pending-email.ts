import { defineGegenproben } from '../define.ts';

/**
 * W9.9 — the pending change of address with private registration (E187, E146): the account keeps its address until the link sent
 * to the new one is clicked; a free and a taken address get the same answer (bytes) in the same time (paired, 21 pairs, the median
 * of the ratios — as 1492620); the owner of a taken one gets a note; the link works for its own signed-in account, its latest
 * request, before it expires, once; taken in the meantime → refused (tryUpdate); a pending address signs nobody in.
 *
 * Masking pairs, each with its own cases: the bytes ↔ the time (G1 a different answer at the same cost; G2 the same answer at a
 * different cost, with the probe G2c: the byte test stays green under G2); the account's id in the link ↔ the change keyed by the
 * signed-in user (G4 both off; G4c/G4d each alone stays green — either holds on its own); the signature's expiry ↔ the request's
 * (G5a/G5b, each test keeps the other one valid); the claimed token ↔ the cleared pending change (G6 both off; G6c the claim alone off
 * stays green). Run on the web app's module (`apps/web-app/modules/auth`); the template of `make:auth` (private by default, E193) is the
 * same code, proven by its own generated tests in the fixture test (packages/auth/src/make-auth.test.ts) and pack:smoke.
 */
const test = (name: string) => ({ vitest: 'apps/web-app/modules/auth/email-change.test.ts', name: `changing the address (private registration, E146) > ${name}` });
const UPDATE = 'apps/web-app/modules/auth/controllers/UpdateEmailController.ts';
const CONFIRM = 'apps/web-app/modules/auth/controllers/ConfirmEmailChangeController.ts';
const USERS = 'apps/web-app/modules/auth/UserRepository.ts';
const ROUTES = 'apps/web-app/modules/auth/routes.ts';
const JOB = 'apps/web-app/modules/auth/jobs/SendEmailChangeMailJob.ts';

/** The request decides and composes the link mail itself for a free address (the old way: rendered here, queued for a worker). */
// (The controller has a Mailer since E193 — the switched-off path mails at once.)
const COMPOSED_IN_THE_REQUEST = [
  { file: UPDATE, find: "import { Queue } from '@bespokecore/queue';", replace: "import { Queue } from '@bespokecore/queue';\nimport { ConfirmNewEmailMail } from '../mail/ConfirmNewEmailMail.ts';" },
  {
    file: UPDATE,
    find: "      await this.#queue.dispatch(SendEmailChangeMailJob, { user: ctx.user.id, email, token, locale: this.#translator.locale }, { queue: 'mail' });",
    replace:
      "      if (!(await this.#users.emailTaken(email))) await this.#mailer.queue(new ConfirmNewEmailMail(ctx.user, email, `https://app.example/email/change/${ctx.user.id}/${token}`, this.#translator), { queue: 'mail' });\n      else await this.#queue.dispatch(SendEmailChangeMailJob, { user: ctx.user.id, email, token, locale: this.#translator.locale }, { queue: 'mail' });",
  },
];
/** The link's account id is not compared with the signed-in user's. */
const NO_ID_CHECK = { file: CONFIRM, find: 'if (ctx.params.id !== String(ctx.user.id)) abort(403', replace: 'if (false as boolean) abort(403' };
/** The change is applied to the account the link names — not to the signed-in user's. */
const KEYED_BY_LINK = { file: CONFIRM, find: 'this.#users.confirmEmailChange(ctx.user.id,', replace: 'this.#users.confirmEmailChange(Number(ctx.params.id),' };
/** The token is not claimed: it stays valid after the click. */
const TOKEN_KEPT = { file: USERS, find: '        .set({ pending_email_token: null })', replace: '        .set({ updated_at: now })' };
/** The pending change is not cleared by the click. */
const PENDING_KEPT = { file: USERS, find: '      const changes = { pending_email: null, pending_email_expires_at: null };', replace: '      const changes = {};' };

export default defineGegenproben({
  step: 'W9.9',
  cases: [
    // --- The same answer: bytes ↔ time ----------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'the request tells "taken" again (a field error): the answer for a taken address differs from a free one’s',
      patch: [
        // (ValidationError is imported since E193 — the switched-off path says "taken".)
        { file: UPDATE, find: '    const { token, hash } = newEmailChangeToken();', replace: "    if (await this.#users.emailTaken(email)) throw new ValidationError({ email: ['This e-mail address is already registered.'] }, { email });\n    const { token, hash } = newEmailChangeToken();" },
      ],
      run: test('answers a free address and a taken one byte for byte alike — the answer, and the page it leads to'),
      expect: /a taken address is answered differently from a free one: expected/,
      masks: 'G2',
    },
    {
      id: 'G2',
      title: 'the request decides and composes the link mail for a free address itself: a taken address answers faster',
      patch: COMPOSED_IN_THE_REQUEST,
      run: test('takes as long for a taken address as for a free one — the request does the same either way (paired)'),
      expect: /median of 21 paired ratios 0\.\d+ .*: expected 0\.\d+ to be greater than 0\.75/,
      masks: 'G1',
    },
    {
      id: 'G2c',
      title: 'masking probe: composed in the request for a free address, the answer’s bytes are still the same (only the time tells)',
      patch: COMPOSED_IN_THE_REQUEST,
      run: test('answers a free address and a taken one byte for byte alike — the answer, and the page it leads to'),
      expectGreen: true,
    },
    // --- Pending until the click ----------------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'the account takes the new address at once (before the click)',
      patch: [{ file: UPDATE, find: '      await this.#users.requestEmailChange(ctx.user.id, { email, tokenHash: hash, expiresAt });', replace: '      await this.#users.requestEmailChange(ctx.user.id, { email, tokenHash: hash, expiresAt });\n      await this.#users.update(ctx.user.id, { email });' }],
      run: test('keeps the account at its address until the link is clicked — then the new one is confirmed, the old one told'),
      expect: /to match object \{ email: 'kj@example\.com'/,
    },
    // --- The link: its account ------------------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: 'the link changes the account it names, whoever is signed in: the inbox’s owner, signed in as somebody else, confirms it',
      patch: [NO_ID_CHECK, KEYED_BY_LINK],
      run: test('a link works for the signed-in account it was made for — not for another, not tampered with, not for a guest'),
      expect: /Expected status 403, got 302/,
    },
    {
      id: 'G4c',
      title: 'masking probe: without the id check alone, the change keyed by the signed-in user still refuses another account',
      patch: [NO_ID_CHECK],
      run: test('a link works for the signed-in account it was made for — not for another, not tampered with, not for a guest'),
      expectGreen: true,
    },
    {
      id: 'G4d',
      title: 'masking probe: keyed by the link alone, the id check still refuses another account',
      patch: [KEYED_BY_LINK],
      run: test('a link works for the signed-in account it was made for — not for another, not tampered with, not for a guest'),
      expectGreen: true,
    },
    // --- The link: its time ---------------------------------------------------------------------------------------------------
    {
      id: 'G5a',
      title: 'the link is not checked for its signature: a link past its time works while the request would still wait',
      patch: [{ file: ROUTES, find: "  signedIn.middleware(signed()).get('/email/change/:id/:token', ConfirmEmailChangeController)", replace: "  signedIn.get('/email/change/:id/:token', ConfirmEmailChangeController)" }],
      run: test('a link past its own time is refused — even while the request would still wait (the signature)'),
      expect: /Expected status 403, got 302/,
      masks: 'G5b',
    },
    {
      id: 'G5b',
      title: 'the request is not checked for its expiry: an expired request is taken while its link still works',
      patch: [{ file: USERS, find: "        .where('pending_email_expires_at', '>', now.toISOString())\n", replace: '' }],
      run: test('a request past its time is refused — even while its link would still work (the row)'),
      expect: /Expected status 403, got 302/,
      masks: 'G5a',
    },
    // --- The link: once, the latest request -----------------------------------------------------------------------------------
    {
      id: 'G6',
      title: 'neither the token claimed nor the pending change cleared: a used link works a second time',
      patch: [TOKEN_KEPT, PENDING_KEPT],
      run: test('a link works once — and only for the latest request'),
      expect: /Expected status 403, got 302/,
    },
    {
      id: 'G6c',
      title: 'masking probe: the token not claimed alone — the cleared pending change still refuses the second click',
      patch: [TOKEN_KEPT],
      run: test('a link works once — and only for the latest request'),
      expectGreen: true,
    },
    // --- The owner of a taken address -----------------------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'the worker sends nothing for a taken address: its owner learns nothing',
      patch: [{ file: JOB, find: "      await this.#mailer.queue(new EmailInUseMail(owner, this.#translators.for(owner.locale ?? payload.locale)), { queue: 'mail' });", replace: '      void EmailInUseMail;' }],
      run: test('notes to the owner of a taken address that someone wanted it — nothing changes for anybody'),
      expect: /Expected a EmailInUseMail matching the filter to be queued\. Queued: nothing/,
    },
    // --- A pending address signs nobody in ------------------------------------------------------------------------------------
    {
      id: 'G8',
      title: 'the login also looks at pending_email: an address nobody confirmed signs in',
      patch: [{ file: USERS, find: "    return this.#credentials(this.query().where('email', '=', email));", replace: "    return this.#credentials(this.query().where((eb) => eb.or([eb('email', '=', email), eb('pending_email', '=', email)])));" }],
      run: test('a pending address signs nobody in — and gets no reset link'),
      expect: /Expected a redirect to \/login, got \/users\/me/,
    },
    // --- Taken in the meantime ------------------------------------------------------------------------------------------------
    {
      id: 'G9',
      title: 'the click updates without tryUpdate: an address registered in the meantime is not refused cleanly (the index throws)',
      patch: [{ file: USERS, find: '      const changed = await users.tryUpdate(id, {', replace: '      const changed = await users.update(id, {' }],
      run: test('refuses the click when another account took the address in the meantime — the unique index decides'),
      expect: /Expected status 409, got 500/,
    },
    // --- Throttle and prune ---------------------------------------------------------------------------------------------------
    {
      id: 'G10',
      title: 'no throttle on the change: every request sends a mail somewhere, without a limit',
      patch: [{ file: ROUTES, find: ".middleware(throttle('email-change')).put('/settings/email'", replace: ".put('/settings/email'" }],
      run: test('throttles changes: the seventh a minute from one account gets 429'),
      expect: /Expected status 429, got 303/,
    },
    {
      id: 'G11',
      title: 'no prune in the schedule: expired changes stay in the rows',
      patch: [{ file: 'apps/web-app/modules/auth/schedule.ts', find: "  s.call(PruneEmailChanges).daily().at('03:10').timezone('Europe/Berlin').onOneServer().name('auth.prune-email-changes');\n", replace: '  void PruneEmailChanges;\n' }],
      run: test('the nightly prune clears the changes nobody confirmed in time — waiting ones stay'),
      expect: /to include 'auth\.prune-email-changes'/,
    },
  ],
});
