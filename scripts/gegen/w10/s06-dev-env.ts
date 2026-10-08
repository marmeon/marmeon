import { defineGegenproben } from '../define.ts';

/**
 * W10.6 — the development host guard (E200) and the positive `NODE_ENV` check (E201).
 *
 * E200: every development route answers only loopback names and `APP_URL`'s host — one guard, `devOnly()` of `@marmeon/core/dev`.
 * Tested without Vite (the kernel in-process: Vite would refuse a foreign host itself, W7.8). Masking pair: one shared function, two
 * routes — each route has its own scenario (G1 mail previews, G2 devtools), and X1 shows the mail test stays green when the devtools
 * lose the guard (a test of one route says nothing about the other). G3–G3c break the shared function itself.
 *
 * E201: isomorphic and server-rendering code checks `=== 'development' || === 'test'`. Each place a staging value is read at run
 * time has its own scenario: the client core (G4, G4b), server rendering (G5), the hydration report (G6). `check:source` rule 3 finds a
 * negative check put back (G7) — X7 shows the staging tests alone miss a site they do not cover (masking pair G7 ↔ X7). G8: a
 * development branch that does not fold (a helper instead of the inline check) ships its explanation in the production bundle.
 */
const MAIL = 'packages/mail/src/index.ts';
const mailTest = { vitest: 'apps/web-app/modules/auth/queued-mails.test.ts', name: 'answer only localhost and the host of APP_URL' } as const;
const devtoolsTest = { vitest: 'packages/devtools/src/pages.test.ts', name: 'answer only localhost, 127.0.0.1' } as const;
const DEV = 'packages/core/src/dev.ts';
const coreTest = { vitest: 'packages/core/src/dev.test.ts' } as const;
const POSITIVE = "process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'";
const NEGATIVE = "process.env.NODE_ENV !== 'production'";
const nodeEnvTest = { vitest: 'packages/http/src/client/node-env.test.ts' } as const;
const R9 = `throw new Error(${POSITIVE} ? '[marmeon:R9] Marmeon hooks must be used inside <MarmeonApp>.' : '[marmeon:R9]');`;
const r9Back = { file: 'packages/react/src/app.tsx', find: R9, replace: R9.replace(POSITIVE, NEGATIVE) };

export default defineGegenproben({
  step: 'W10.6',
  cases: [
    // --- E200: one guard on every development route -----------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'the mail preview list without the guard: Host evil.example reads it (200) — DNS rebinding',
      patch: [{ file: MAIL, find: "Route.get('/_marmeon/mail', devOnly(hosts, () => previews.index()));", replace: "Route.get('/_marmeon/mail', () => previews.index());" }],
      run: mailTest,
      expect: /evil\.example \/_marmeon\/mail: expected 200 to be 403/,
      masks: 'G2',
    },
    {
      id: 'G1b',
      title: 'one mail preview without the guard: Host evil.example reads the mail (200)',
      patch: [
        {
          file: MAIL,
          find: "Route.get('/_marmeon/mail/:module/:mail', devOnly(hosts, (ctx) => previews.show(`${ctx.params.module}/${ctx.params.mail}`, new URL(ctx.request.url))));",
          replace: "Route.get('/_marmeon/mail/:module/:mail', (ctx) => previews.show(`${ctx.params.module}/${ctx.params.mail}`, new URL(ctx.request.url)));",
        },
      ],
      run: mailTest,
      expect: /evil\.example \/_marmeon\/mail\/auth\/VerifyEmailMail: expected 200 to be 403/,
    },
    {
      id: 'G2',
      title: 'the devtools without their guard middleware: Host evil.example reads /_marmeon/devtools',
      patch: [{ file: 'packages/devtools/src/pages/index.ts', find: '      Route.middleware(guard)\n        .prefix(BASE)', replace: '      Route.prefix(BASE)' }],
      run: devtoolsTest,
      expect: /evil\.example \/_marmeon\/devtools[^:]*: expected 200 to be 403/,
      masks: 'G1',
    },
    {
      id: 'X1',
      title: 'masking probe: the devtools lose the guard — the mail previews\' test stays green (each route needs its own test)',
      patch: [{ file: 'packages/devtools/src/pages/index.ts', find: '      Route.middleware(guard)\n        .prefix(BASE)', replace: '      Route.prefix(BASE)' }],
      run: mailTest,
      expectGreen: true,
    },
    {
      id: 'G3',
      title: 'the shared check lets every host through: the core test names the first foreign host',
      patch: [{ file: DEV, find: '  return host.length <= 255 && !/[/?#@\\\\]/.test(host) && hosts.has(hostname);', replace: '  return host.length > 0 || hostname !== undefined;' }],
      run: coreTest,
      expect: /evil\.example: expected true to be false/,
    },
    {
      id: 'G3b',
      title: 'the shared check without its character rule: a path smuggled into Host (localhost/x) passes',
      patch: [{ file: DEV, find: '  return host.length <= 255 && !/[/?#@\\\\]/.test(host) && hosts.has(hostname);', replace: '  return host.length <= 255 && hosts.has(hostname);' }],
      run: coreTest,
      expect: /localhost\/x: expected true to be false/,
    },
    {
      id: 'G3c',
      title: 'devOnly without the dev headers: a preview leaves without CORP same-origin (and no-store)',
      patch: [{ file: DEV, find: 'return hostAllowed(args[0].request, hosts) ? devSecured(await handler(...args)) : forbiddenDevHost();', replace: 'return hostAllowed(args[0].request, hosts) ? await handler(...args) : forbiddenDevHost();' }],
      run: mailTest,
      expect: /localhost:3960 \/_marmeon\/mail: expected null to be 'same-origin'/,
    },
    // --- E201: staging is not development --------------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: 'the client core asks !== production again (C1): NODE_ENV=staging gets the explanation',
      patch: [
        {
          file: 'packages/http/src/client/routes.ts',
          find: `      (${POSITIVE})\n        ? \`[marmeon:C1] Route`,
          replace: `      ${NEGATIVE}\n        ? \`[marmeon:C1] Route`,
        },
      ],
      run: nodeEnvTest,
      expect: /NODE_ENV=staging c1: expected '\[marmeon:C1\] Route \[people\.show\]: the/,
    },
    {
      id: 'G4b',
      title: 'isDevelopment() asks !== production again: staging counts as development (error details in server rendering)',
      patch: [{ file: 'packages/http/src/client/document.ts', find: `    return ${POSITIVE};`, replace: `    return ${NEGATIVE};` }],
      run: nodeEnvTest,
      expect: /NODE_ENV=staging development: expected true to be false/,
    },
    {
      id: 'G5',
      title: 'server rendering resolves a page with !== production again (R2): staging renders the explanation',
      patch: [
        {
          file: 'packages/react/src/pages.ts',
          find: `        ${POSITIVE} ? \`[marmeon:R2] Page`,
          replace: `        ${NEGATIVE} ? \`[marmeon:R2] Page`,
        },
      ],
      run: { vitest: 'packages/react/src/server.test.tsx', name: 'takes no development branch with NODE_ENV=staging' },
      expect: /to throw error matching .* but got '\[marmeon:R2\] Page \[app\/Nope\] not/,
    },
    {
      id: 'G5b',
      title: 'server rendering warns about a late <Head> on staging (isDevelopment negative): the warning reaches the log',
      patch: [{ file: 'packages/http/src/client/document.ts', find: `    return ${POSITIVE};`, replace: `    return ${NEGATIVE};` }],
      run: { vitest: 'packages/react/src/server.test.tsx', name: 'takes no development branch with NODE_ENV=staging' },
      expect: /expected "vi\.fn\(\)" to not be called at all, but actually been called 1 times/,
    },
    {
      id: 'G6',
      title: 'the hydration report asks === production again: a staging page shows the development notice',
      patch: [{ file: 'packages/react/src/client.tsx', find: `  if (!(${POSITIVE})) {`, replace: "  if (process.env.NODE_ENV === 'production') {" }],
      run: { vitest: 'packages/react/src/client.test.tsx', name: 'reports a mismatch like production with NODE_ENV=staging' },
      expect: /the development notice: expected '\[marmeon\] Hydration mismatch/,
    },
    // --- check:source rule 3 -------------------------------------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'a negative check put back where no staging test looks (R9 in app.tsx): check:source names the line',
      patch: [r9Back],
      run: { command: ['pnpm', 'run', 'check:source'] },
      expect: /NODE_ENV checked positively \(E201[^\n]*packages\/react\/src\/app\.tsx:\d+:/,
      masks: 'X7',
    },
    {
      id: 'X7',
      title: 'masking probe: the same site put back — the staging tests stay green; only the rule finds it',
      patch: [r9Back],
      run: { vitest: ['packages/http/src/client/node-env.test.ts', 'packages/react/src/server.test.tsx', 'packages/react/src/client.test.tsx'] },
      expectGreen: true,
    },
    {
      id: 'G7b',
      title: 'rule 3 matches nothing: the rule\'s own test finds the planted lines missing',
      patch: [
        { file: 'scripts/check-source.ts', find: 'const NEGATIVE_ENV = new RegExp(\n  [', replace: "const NEGATIVE_ENV = new RegExp(\n  '(?!)(?:' + [" },
        { file: 'scripts/check-source.ts', find: "  ].join('|'),\n);\n/**\n * Code people run or copy", replace: "  ].join('|') + ')',\n);\n/**\n * Code people run or copy" },
      ],
      run: { vitest: 'scripts/ci.test.ts', name: 'finds a negative or a production check' },
      expect: /expected \[\] to deeply equal \[/,
    },
    // --- The client build folds the check ------------------------------------------------------------------------------------------
    {
      id: 'G8',
      title: 'a development branch that does not fold (R9 behind an array lookup, in dist/): the production bundle ships the explanation',
      patch: [
        {
          file: 'packages/react/dist/app.js',
          find: `throw new Error(${POSITIVE} ? '[marmeon:R9]`,
          replace: "throw new Error(['development', 'test'].includes(process.env.NODE_ENV) ? '[marmeon:R9]",
        },
      ],
      run: { vitest: 'packages/react/src/bundle-size.test.ts', name: 'a production bundle says codes, not explanations' },
      expect: /expected \[ 'must be used inside <MarmeonApp>' \] to deeply equal \[\]/,
    },
  ],
});
