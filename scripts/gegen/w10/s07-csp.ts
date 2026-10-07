import { defineGegenproben } from '../define.ts';

/**
 * W10.7 — no inline style under a strict `style-src` (E202), paid for by a lazy failure chunk (E204: no budget reset).
 *
 * SSR: the framework's components and the auth stubs render no `style` attribute — LayerDialog (G1, G3), the server's error dialog
 * (G4), the built-in error page (G5), the stub layouts in a generated app (G6). Masking pair G1 ↔ G2: LayerDialog's `style` prop is
 * kept off the server's markup (G1) AND written through the CSSOM after the mount (G2) — X1 shows the hydration test alone stays
 * green when the attribute comes back (the style arrives either way), so each measure has its own scenario.
 *
 * The look ships: make:auth imports the module's stylesheet (G7); `@marmeon/react/styles.css` is exported (G9 — the kit's build fails
 * in pack:smoke) and packed (G9b — pack:check: the export points at a file the tarball lacks); the starter kit imports it (G10 — the built index.html links no `.marmeon-layer`);
 * pack:check skips the stylesheet in attw (G11).
 *
 * The budget: what a failure shows is a chunk of its own — the failure dialogs (G8) and the built-in error page (G8b) back in the first
 * download turn the leak test red (`dist/` patched: the size test measures the build). A chunk that cannot load never fails the app
 * (G12), and offline the notice is no chunk (G13).
 *
 * The devtools' bar (development) brings its look as a constructed stylesheet, not a `<style>` element without the nonce (G15) — found
 * in the browser once the web app's own policy limited `style-src`.
 *
 * The browser (G14, G14b): `pnpm csp:probe` — the web app built and started, headless Chrome under `style-src 'self'` with a violation
 * counter. The old LayerDialog (an inline style in the server's markup) is a `style-src-attr` violation (G14); a frame whose style
 * prop never reaches the dialog leaves the app's `--layer-depth` unset (G14b) — the masking pair of G1 ↔ G2 in the real browser.
 * Each run of G14/G14b rebuilds apps/web-app/dist with the patched framework: build it again afterwards (or `--control`).
 */
const MINUTES = 60_000;
const DIALOG = 'packages/react/src/layer-dialog.tsx';
const STYLE_AFTER_MOUNT = 'style={mounted ? style : undefined}';
const inlineStyles = 'packages/react/src/inline-styles.test.tsx';
const ssrTest = { vitest: inlineStyles, name: 'on the server: a deep link' } as const;
const hydrationTest = { vitest: inlineStyles, name: 'after hydrating' } as const;
const leakTest = (what: string) => ({ vitest: 'packages/react/src/bundle-size.test.ts', name: `${what} in emptyApp` }) as const;
const smoke = { command: ['pnpm', 'run', 'pack:smoke'], timeout: 15 * MINUTES } as const;
const packCheck = { command: ['pnpm', 'run', 'pack:check'], timeout: 10 * MINUTES } as const;
const probe = { command: ['node', 'scripts/csp-probe.ts', '--app', 'apps/web-app', '--build'], timeout: 10 * MINUTES } as const;
const DIST_DIALOG = 'packages/react/dist/layer-dialog.js';
const DIST_STYLE_AFTER_MOUNT = 'style: mounted ? style : undefined';

export default defineGegenproben({
  step: 'W10.7',
  cases: [
    // --- SSR without a style attribute ------------------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'LayerDialog renders its style prop on the server → a style attribute in the deep link’s markup',
      patch: [{ file: DIALOG, find: STYLE_AFTER_MOUNT, replace: 'style={style}' }],
      run: ssrTest,
      expect: /inline styles in the server’s markup — <dialog/,
      masks: 'G2',
    },
    {
      id: 'X1',
      title: 'masking probe: the same patch — the hydration test alone stays green (the style arrives either way)',
      patch: [{ file: DIALOG, find: STYLE_AFTER_MOUNT, replace: 'style={style}' }],
      run: hydrationTest,
      expectGreen: true,
    },
    {
      id: 'G2',
      title: 'LayerDialog never writes its style prop (no CSSOM after the mount) → the app’s style is lost after hydrating',
      patch: [{ file: DIALOG, find: STYLE_AFTER_MOUNT, replace: 'style={undefined}' }],
      run: hydrationTest,
      expect: /the style prop after the mount: expected '' to be '480px'/,
      masks: 'G1',
    },
    {
      id: 'G3',
      title: 'LayerDialog’s content box back to its inline padding (the old default look)',
      patch: [{ file: DIALOG, find: '<div className="marmeon-layer__content">', replace: "<div style={{ padding: '1.5rem', paddingInlineEnd: '3rem' }}>" }],
      run: ssrTest,
      expect: /inline styles in the server’s markup — <div style="padding:1\.5rem;padding-inline-end:3rem">/,
    },
    {
      id: 'G4',
      title: 'the server’s error dialog frames a proxy’s HTML with an inline style',
      patch: [{ file: 'packages/react/src/failure.tsx', find: 'className="marmeon-failure__frame"', replace: "style={{ width: '100%', height: '70vh', border: 0 }}" }],
      run: { vitest: inlineStyles, name: 'with the HTML of a proxy' },
      expect: /style="width:100%;height:70vh;border:0"/,
    },
    {
      id: 'G5',
      title: 'the built-in error page with an inline style',
      patch: [{ file: 'packages/react/src/error-page.tsx', find: '<p className="marmeon-error__status">', replace: '<p style={{ opacity: 0.6 }}>' }],
      run: { vitest: inlineStyles, name: 'the built-in error page' },
      expect: /style="opacity:0\.6"/,
    },
    {
      id: 'G6',
      title: 'a make:auth stub layout with an inline style → the generated app’s own SSR test is red',
      patch: [{ file: 'packages/auth/stubs/react/modules/auth/layouts/SettingsLayout.tsx', find: '<div className="auth-settings">', replace: "<div style={{ display: 'flex' }}>" }],
      run: { vitest: 'packages/auth/src/make-auth.test.ts', name: 'gives a new app a working auth area', timeout: 10 * MINUTES },
      expect: /generated tests failed: modules\/auth\/auth\.test\.ts > the pages, rendered on the server > carry no style attribute/,
    },

    // --- the look ships -----------------------------------------------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'make:auth writes no import of the module’s stylesheet into bootstrap/client.tsx',
      patch: [
        {
          file: 'packages/auth/src/make-auth.ts',
          find: String.raw`  writeFileSync(file, ` + '`${source.slice(0, at)}\\n${AUTH_STYLES_IMPORT} // the auth module\'s look (make:auth)${source.slice(at)}`);',
          replace: '  void at;',
        },
      ],
      run: { vitest: 'packages/auth/src/make-auth.test.ts', name: 'writes the module, registers it' },
      expect: /Target cannot be null or undefined/,
    },
    {
      id: 'G9',
      title: '@marmeon/react does not export ./styles.css → the starter kit’s build fails (pack:smoke)',
      patch: [{ file: 'packages/react/package.json', find: '      },\n      "./styles.css": "./styles.css"\n    }', replace: '      }\n    }' }],
      run: smoke,
      expect: /"\.\/styles\.css" is not exported under the conditions/,
    },
    {
      id: 'G9b',
      title: 'styles.css not in the package’s files → pack:check (the export points at a file the tarball lacks)',
      patch: [{ file: 'packages/react/package.json', find: '    "styles.css",\n', replace: '' }],
      run: packCheck,
      expect: /exports\["\.\/styles\.css"\] → \.\/styles\.css is not in the tarball/,
    },
    {
      id: 'G10',
      title: 'the starter kit’s client entry without the framework’s stylesheet → its built index.html links no .marmeon-layer',
      patch: [
        {
          file: 'packages/create-marmeon/template/kit/bootstrap/client.tsx',
          find: "import '@marmeon/react/styles.css'; // the framework's look: layers, dialogs, the error page (E202 — a stylesheet, no inline style)\n",
          replace: '',
        },
      ],
      run: smoke,
      expect: /without \.marmeon-layer, \.marmeon-failure \(E202\)/,
    },
    {
      id: 'G11',
      title: 'pack:check hands the stylesheet to attw (no types to resolve there)',
      patch: [{ file: 'scripts/pack-check.ts', find: "...(stylesheets.length > 0 ? ['--exclude-entrypoints', ...stylesheets] : []),", replace: '' }],
      run: packCheck,
      expect: /"@marmeon\/react\/styles\.css"[\s\S]*Resolution failed/,
    },

    // --- the budget: a chunk of its own -------------------------------------------------------------------------------------------------
    {
      id: 'G8',
      title: 'the failure dialogs imported statically again (dist) → in the first download',
      patch: [
        { file: 'packages/react/dist/fallbacks.js', find: "import { Component, lazy, Suspense } from 'react';", replace: "import { Component, lazy, Suspense } from 'react';\nimport * as failureModule from './failure.js';" },
        { file: 'packages/react/dist/fallbacks.js', find: "const loadFailure = () => import('./failure.js').catch(() => unloaded);", replace: 'const loadFailure = () => Promise.resolve(failureModule).catch(() => unloaded);' },
      ],
      run: leakTest('the failure dialogs are a chunk of their own'),
      expect: /the failure dialogs in the first download/,
    },
    {
      id: 'G8b',
      title: 'the built-in error page imported statically again (dist) → in the first download',
      patch: [
        { file: 'packages/react/dist/pages.js', find: "import { Backdrop } from './backdrop.js';", replace: "import { Backdrop } from './backdrop.js';\nimport { ErrorPage } from './error-page.js';" },
        { file: 'packages/react/dist/pages.js', find: "return (await import('./error-page.js')).ErrorPage;", replace: 'return ErrorPage;' },
      ],
      run: leakTest('the failure dialogs are a chunk of their own'),
      expect: /the built-in error page in the first download/,
    },
    {
      id: 'G12',
      title: 'the failure chunk’s import without its fallback → a chunk that cannot load fails the app',
      patch: [{ file: 'packages/react/src/fallbacks.tsx', find: "import('./failure.tsx').catch(() => unloaded)", replace: "import('./failure.tsx')" }],
      run: { vitest: 'packages/react/src/failure-unloaded.test.tsx', name: 'a 5xx shows the notice' },
      expect: /Failed to fetch dynamically imported module|error when mocking a module/,
    },
    {
      id: 'G13',
      title: 'an unreachable server through the lazy chunk too → the server’s dialog instead of the notice',
      patch: [{ file: 'packages/react/src/fallbacks.tsx', find: "  if (failure.type === 'network') return <NetworkNotice onDismiss={onDismiss} />;\n", replace: '' }],
      run: { vitest: 'packages/react/src/app.test.tsx', name: 'shows a notice when the server cannot be reached' },
      expect: /Cannot read properties of null \(reading 'textContent'\)/,
    },

    {
      id: 'G15',
      title: 'the devtools’ bar back to a <style> element in its shadow root → refused by the web app’s strict style-src under marmeon dev',
      patch: [{ file: 'packages/devtools/src/client/bar.ts', find: '    adoptStyles(this.root, win);\n', replace: "    this.root.append(h('style', {}, STYLES));\n" }],
      run: { vitest: 'packages/devtools/src/client/bar.test.ts', name: 'constructed stylesheet' },
      expect: /a <style> element in the bar: expected <style>/,
    },

    // --- the browser: the CSP counter -------------------------------------------------------------------------------------------------
    {
      id: 'G14',
      title: 'csp:probe with the old LayerDialog (a style attribute in the server’s markup) → a style-src-attr violation on the deep link',
      patch: [{ file: DIST_DIALOG, find: DIST_STYLE_AFTER_MOUNT, replace: 'style: { padding: 0, ...style }' }],
      run: probe,
      expect: /✗ layer by deep link \/users\/1\/edit: 1 CSP violation\(s\): style-src-attr inline/,
      masks: 'G14b',
    },
    {
      id: 'G14b',
      title: 'csp:probe with a LayerDialog that never writes its style prop → the web app’s --layer-depth is missing (no violation)',
      patch: [{ file: DIST_DIALOG, find: DIST_STYLE_AFTER_MOUNT, replace: 'style: undefined' }],
      run: probe,
      expect: /✗ layer by deep link \/users\/1\/edit: the frame's style prop \(--layer-depth through the CSSOM\) is "" — expected "1"/,
      masks: 'G14',
    },
  ],
});
