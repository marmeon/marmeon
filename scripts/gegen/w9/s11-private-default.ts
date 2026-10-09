import { defineGegenproben } from '../define.ts';

/**
 * W9.11 (after Wave 9, E193) — private registration is the default: `make:auth` writes one module whose controllers read
 * `AuthConfig.privateRegistration` (`AUTH_PRIVATE_REGISTRATION`, on unless `false`; only `true`/`false` boot), the `--private-registration`
 * flags are gone with a notice, and switching it off outside development and tests warns at boot.
 *
 * The default proven twice: on the web app's module and on the generated module (the fixture test generates, migrates and runs its
 * tests). The switch decides — never the input: a branch by the address breaks the bytes (G2a, G2b) or, with the same answer, the
 * time (G2c; the masking probe G2d shows the byte test alone stays green there). Masking pair G6 ↔ G6b: `ConfirmedAddress` asks for
 * a confirmed address only while private — always letting through and always asking each break a test of their own.
 */
const WEB = 'apps/web-app/modules/auth';
const REGISTER = `${WEB}/controllers/RegisterController.ts`;
const UPDATE = `${WEB}/controllers/UpdateEmailController.ts`;
const CONFIRMED = `${WEB}/middleware/ConfirmedAddress.ts`;
const CONFIG = 'packages/auth/src/config.ts';
const registration = (name: string) => ({ vitest: `${WEB}/auth.test.ts`, name });
const fixture = { vitest: 'packages/auth/src/make-auth.test.ts', name: 'gives a new app a working auth area' };

/** The default turned round: `AUTH_PRIVATE_REGISTRATION` unset means off. */
const DEFAULT_OFF = { file: CONFIG, find: "AUTH_PRIVATE_REGISTRATION: env.in(['true', 'false']).default('true'),", replace: "AUTH_PRIVATE_REGISTRATION: env.in(['true', 'false']).default('false')," };
/** The sign-up asks the database first and, for a known address, only queues the note — no hash: the same answer, faster. */
const KNOWN_ADDRESS_SHORTCUT = {
  file: REGISTER,
  find: '    const hash = await this.#hasher.make(ctx.body.password);',
  replace:
    "    if (this.#private && (await this.#users.findByEmail(email))) {\n      await this.#queue.dispatch(SendAccountExistsMailJob, { email, locale }, { queue: 'mail' });\n      return this.redirect().route('auth.register.sent');\n    }\n    const hash = await this.#hasher.make(ctx.body.password);",
};

export default defineGegenproben({
  step: 'W9.11',
  cases: [
    // --- The default is on ----------------------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'the default is off: the web app signs a sign-up in at once instead of "check your inbox" (its warm-up sign-up already)',
      patch: [DEFAULT_OFF],
      run: registration('gets the answer a new one gets'),
      expect: /Expected a redirect to \/register\/sent, got \/users\/me/,
    },
    {
      id: 'G1c',
      title: 'the default is off: AuthConfig without AUTH_PRIVATE_REGISTRATION says false',
      patch: [DEFAULT_OFF],
      run: { vitest: 'packages/auth/src/private-registration.test.ts', name: 'is on unless set to false' },
      expect: /unset, private registration must be on: expected false to be true/,
    },
    {
      id: 'G1b',
      title: 'the default is off: the generated module\'s private tests fail (make:auth)',
      patch: [DEFAULT_OFF],
      run: fixture,
      expect: /generated tests failed: modules\/auth\/registration\.test\.ts > private registration — the default > /,
    },
    // --- The switch decides, never the input ----------------------------------------------------------------------------------
    {
      id: 'G2a',
      title: 'the sign-up picks its path by the address: a known address goes the switched-off way and is told "taken"',
      patch: [{ file: REGISTER, find: '    if (this.#private) {', replace: '    if (this.#private && !(await this.#users.findByEmail(email))) {' }],
      run: registration('answers a new and a known address byte for byte alike'),
      expect: /a known address is answered differently from a new one: expected/,
    },
    {
      id: 'G2b',
      title: 'the change of address picks its path by the address: a taken one changes "at once" — and is told "taken"',
      patch: [{ file: UPDATE, find: '    if (!this.#private) return this.#changeNow(ctx.user, email);', replace: '    if (!this.#private || (await this.#users.findByEmail(email))) return this.#changeNow(ctx.user, email);' }],
      run: { vitest: `${WEB}/email-change.test.ts`, name: 'answers a free address and a taken one byte for byte alike' },
      expect: /a taken address is answered differently from a free one: expected/,
    },
    {
      id: 'G2c',
      title: 'the sign-up decides by the address before hashing: the same answer for a known address, but without the hash',
      patch: [KNOWN_ADDRESS_SHORTCUT],
      run: registration('takes as long for a known address as for a new one'),
      expect: /median of 21 paired ratios 0\.\d+ .* expected 0\.\d+ to be greater than 0\.75/,
    },
    {
      id: 'G2d',
      title: 'masking probe: decided by the address before hashing, the answer’s bytes are still the same (only the time tells)',
      patch: [KNOWN_ADDRESS_SHORTCUT],
      run: registration('answers a new and a known address byte for byte alike'),
      expectGreen: true,
    },
    {
      id: 'G2e',
      title: 'the template\'s sign-up picks its path by the address (make:auth): its generated byte test fails',
      patch: [{ file: 'packages/auth/stubs/react/modules/auth/controllers/RegisterController.ts', find: '    if (this.#private) {', replace: '    if (this.#private && !(await this.#users.findByEmail(email))) {' }],
      run: fixture,
      expect: /generated tests failed: modules\/auth\/registration\.test\.ts > private registration — the default > answers a new and a known address/,
    },
    // --- Only true and false boot ---------------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'any value but "true" turns it off quietly: a typo ("no", "0") boots with private registration off',
      patch: [{ file: CONFIG, find: "AUTH_PRIVATE_REGISTRATION: env.in(['true', 'false']).default('true'),", replace: "AUTH_PRIVATE_REGISTRATION: env.string().default('true')," }],
      run: { vitest: 'packages/auth/src/private-registration.test.ts', name: 'is on unless set to false' },
      expect: /promise resolved .* instead of rejecting/,
    },
    // --- The old flags --------------------------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: 'make:auth takes --private-registration without a word: whoever passes it never learns it is gone',
      patch: [{ file: 'packages/auth/src/make-auth.ts', find: "    if (input.options['private-registration'] !== undefined) input.output.warn(PRIVATE_REGISTRATION_FLAG_GONE);\n", replace: '' }],
      run: { vitest: 'packages/auth/src/make-auth.test.ts', name: 'makes one module, private by default' },
      expect: /expected '✓ Created modules\/auth \(\d+ files\)' to be '! --private-registration is gone/,
    },
    {
      id: 'G4b',
      title: 'create-marmeon takes --private-registration without a word',
      patch: [{ file: 'packages/create-marmeon/src/main.ts', find: "  if (values['private-registration'] !== undefined) err(PRIVATE_REGISTRATION_FLAG_GONE);\n", replace: '' }],
      run: { vitest: 'packages/create-marmeon/src/create.test.ts', name: 'the starter kit adds the home module' },
      expect: /expected '' to be 'create-marmeon: --private-registr/,
    },
    // --- The boot warning -----------------------------------------------------------------------------------------------------
    {
      id: 'G5',
      title: 'switched off in production without a word at boot',
      patch: [{ file: 'packages/auth/src/index.ts', find: '    if (config.protected && !config.privateRegistration) app', replace: '    if ((false as boolean) && config.protected && !config.privateRegistration) app' }],
      run: { vitest: 'packages/auth/src/private-registration.test.ts', name: 'turned off outside development and tests' },
      expect: /production: the boot must warn once: expected \[\]/,
    },
    {
      id: 'G5b',
      title: 'the warning only for NODE_ENV=production: staging and a missing NODE_ENV stay quiet (not fail-closed, E139)',
      patch: [{ file: CONFIG, find: '    protected: environment.isProtected(e),', replace: "    protected: e.NODE_ENV === 'production'," }],
      run: { vitest: 'packages/auth/src/private-registration.test.ts', name: 'turned off outside development and tests' },
      expect: /staging \(protected, E139\): the boot must warn: expected \[\]/,
    },
    // --- A confirmed address: only while private ------------------------------------------------------------------------------
    {
      id: 'G6',
      title: 'ConfirmedAddress lets everyone through: with private registration an unconfirmed account reaches the settings',
      patch: [{ file: CONFIRMED, find: '    return this.#verified ? this.#verified.handle(ctx, next) : next();', replace: '    return next();' }],
      run: registration('opens the app only for a confirmed address'),
      expect: /Expected a redirect, got 200/,
      masks: 'G6b',
    },
    {
      id: 'G6b',
      title: 'ConfirmedAddress always asks: switched off, a new account with a typo in its address cannot reach the settings to fix it',
      patch: [{ file: CONFIRMED, find: '    this.#verified = config.privateRegistration ? new Verified(router) : undefined;', replace: '    this.#verified = config.privateRegistration || true ? new Verified(router) : undefined;' }],
      run: { vitest: `${WEB}/email-change.test.ts`, name: 'changes it at once, unconfirmed' },
      expect: /Expected a page response \(auth\/Security\)/,
      masks: 'G6',
    },
    // --- The private pages when switched off ----------------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'switched off, "check your inbox" still answers: a page for a sign-up that never leads there',
      patch: [{ file: `${WEB}/controllers/ShowRegistrationSentController.ts`, find: '    if (!this.#private) abort(404);\n', replace: '' }],
      run: registration('like Laravel Breeze > signs a new account in at once'),
      expect: /Expected status 404, got 200/,
    },
  ],
});
