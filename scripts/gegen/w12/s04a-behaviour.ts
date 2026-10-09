import { defineGegenproben } from '../define.ts';

/**
 * W12.4a — the behaviour findings of the docs wave. A case per finding whose fix is a measure against recurrence; the case's id is
 * the finding's number.
 *
 * - **The image's health check follows `HEALTH_PATH=off`** (G6) — without the switch it fetches `http://127.0.0.1:3000off` and the
 *   container turns unhealthy although the app runs.
 * - **`marmeon <command> --help` prints the command's help** (G7) — without `wantsHelp()` the flag is an unknown option: exit 1.
 * - **A `<Link>` that sends is a real form** — four measures, each its own case: a `type="button"` again (G8) does nothing without
 *   JavaScript (the starter's sign-out among them); the page's token left out (G8b) gets the session's form a 419; the click not
 *   stopped (G8c) posts the form beside the visit — two requests, the second after the page changed; a link with `confirm` that
 *   submits anyway (G8d) sends without asking before the app started.
 * - **A read-only request's message names its own cause** — the layer's base (G9) and the deferred prop streamed after the headers
 *   (G9b) without a rule of their own fall back to an island's: "an island is read-only … Do that in the page".
 * - **A provider with only `static solutions` is one** (G11) — without the check's third static it stops the start.
 */
const HEALTHCHECK = { vitest: 'packages/cli/src/make-docker.test.ts', name: 'checks nothing with HEALTH_PATH=off' } as const;
const COMMAND_HELP = { vitest: 'packages/cli/src/cli.test.ts', name: 'for --help, without running it' } as const;
const LINK_FORM = { vitest: 'packages/react/src/routes.test.tsx', name: 'renders a link that sends as a real form' } as const;
const LINK_VISIT = { vitest: 'packages/react/src/prefetch-poll.test.tsx', name: 'sends one visit with JavaScript' } as const;
const LINK = 'packages/react/src/link.tsx';
const KERNEL = 'packages/server/src/kernel.ts';

export default defineGegenproben({
  step: 'W12.4a',
  cases: [
    {
      id: 'G6',
      title: 'the health check ignores HEALTH_PATH=off: it fetches 127.0.0.1:3000off and fails, the container turns unhealthy',
      patch: [{ file: 'packages/cli/src/docker.ts', find: "p==='off'?process.exit(0):fetch(", replace: 'fetch(' }],
      run: HEALTHCHECK,
      expect: /expected 1 to be \+0/,
    },
    {
      id: 'G7',
      title: '--help is not asked for: marmeon make:controller --help fails with "Unknown option" (exit 1)',
      patch: [{ file: 'packages/cli/src/command.ts', find: "return flags.some((flag) => (flag === '--help' || flag === '-h')", replace: "return flags.some((flag) => (flag === '--nohelp' || flag === '-h')" }],
      run: COMMAND_HELP,
      expect: /expected 1 to be \+0/,
    },
    {
      id: 'G8',
      title: 'the button of a link that sends is type="button" again: without JavaScript the sign-out does nothing',
      patch: [{ file: LINK, find: "<button type={confirm === undefined ? 'submit' : 'button'}", replace: '<button type="button"' }],
      run: LINK_FORM,
      expect: /\["<form class=\\"marmeon-link\\" action=\\"\/logout\\" method=\\"post\\"><input type=\\"hidden\\" name=\\"_token\\" value=\\"t0ken\\"\/><button type=\\"button\\">Sign out<\/button>.*: expected/,
    },
    {
      id: 'G8b',
      title: "the form leaves the page's CSRF token out: a signed-in user's sign-out without JavaScript fails with 419",
      patch: [{ file: LINK, find: '        {page.csrf !== undefined && <input type="hidden" name={FORM_TOKEN_FIELD}', replace: '        {false && <input type="hidden" name={FORM_TOKEN_FIELD}' }],
      run: LINK_FORM,
      expect: /\["<form class=\\"marmeon-link\\" action=\\"\/logout\\" method=\\"post\\"><button type=\\"submit\\">Sign out<\/button><\/form>",.*: expected/,
    },
    {
      id: 'G8c',
      title: 'the click is not stopped: the browser posts the form beside the visit',
      patch: [{ file: LINK, find: "      event.preventDefault();\n      void visit(href, { method, data, ...options });", replace: '      void visit(href, { method, data, ...options });' }],
      run: LINK_VISIT,
      expect: /expected 1 to be \+0/,
    },
    {
      id: 'G8d',
      title: 'a link with confirm submits its form: before the app started it sends without asking',
      patch: [{ file: LINK, find: "<button type={confirm === undefined ? 'submit' : 'button'}", replace: '<button type="submit"' }],
      run: LINK_FORM,
      expect: /<button type=\\"submit\\">Sign out everywhere<\/button><\/form>"\]: expected/,
    },
    {
      id: 'G9',
      title: "a layer's base has no rule of its own: its write is reported as an island's",
      patch: [{ file: KERNEL, find: "            : island\n              ? undefined\n              : \"a layer's base is read-only", replace: "            : true\n              ? undefined\n              : \"a layer's base is read-only" }],
      run: { vitest: 'packages/server/src/layers.test.ts', name: 'resolves the base read-only' },
      expect: /in a layer's base, resolved for its deep link \(GET \/writes\): an island is read-only .*: expected/,
    },
    {
      id: 'G9b',
      title: 'a deferred prop streamed after the headers has no rule of its own: its write is reported as an island\'s',
      patch: [{ file: KERNEL, find: "        rule: 'the response headers are out — ", replace: "        _rule: 'the response headers are out — " }],
      run: { vitest: 'packages/server/src/islands-ssr.test.ts', name: 'a deferred prop that writes after the headers throws in development' },
      expect: /after its response headers were sent \(a deferred prop, streamed with the page\): an island is read-only .*: expected/,
    },
    {
      id: 'G11',
      title: 'a provider that only brings solutions stops the start: "has no register(), boot(), …"',
      patch: [{ file: 'packages/core/src/application.ts', find: ' && !Provider.health?.length && !Provider.solutions?.length) {', replace: ' && !Provider.health?.length) {' }],
      run: { vitest: 'packages/core/src/application.test.ts', name: 'accepts a provider that only brings solutions' },
      expect: /promise rejected "TypeError: OnlySolutions is listed as a s…" instead of resolving/,
    },
  ],
});
