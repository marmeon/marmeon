import { defineGegenproben } from '../define.ts';

/**
 * W9.8 — view transitions (E185): the core's around the swap of a page (loaded first; the render in the update, the history entry and
 * the scroll once it is in), skipped under reduced motion and in a hidden tab, `back`/`forward` on Back/Forward, React's in
 * `viewTransition: 'react'` (the page change in `startTransition` with its types — the core starts none: never two), `startTransition`
 * only with the option, the render's promise only once the page is committed, the feature's code only when asked for (and never in a
 * first download), no inline styles in the server's markup.
 *
 * The CSP case is the server's markup (G9, deterministic): the browser's violation counter needs a production build, a server and
 * Chrome — and the web app's policy has no `style-src` (an inline style violates nothing there), so a patched style would not count. Run
 * by hand: scratchpad `w9s8/vt.mjs <base> react|core` (0 violations, prod and staging). G8b patches `dist/` (the size test measures it):
 * run `pnpm build` first.
 */
const core = (name: string) => ({ vitest: 'packages/http/src/client/view-transitions.test.ts', name });
const react = (name: string) => ({ vitest: 'packages/react/src/view-transitions.test.tsx', name });
const FEATURE = 'packages/http/src/client/features/view-transitions.ts';
const NAVIGATION = 'packages/http/src/client/navigation.ts';
const APP = 'packages/react/src/app.tsx';

export default defineGegenproben({
  step: 'W9.8',
  cases: [
    // --- Skipped: reduced motion, a hidden tab --------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'prefers-reduced-motion is not asked: the page freezes for an animation the user turned off',
      patch: [{ file: FEATURE, find: " || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;", replace: ') return undefined;' }],
      run: core('when the user prefers reduced motion'),
      expect: /a view transition under prefers-reduced-motion: reduce/,
    },
    {
      id: 'G2',
      title: 'a hidden tab is not asked: a transition nobody sees (the browser skips it anyway, after freezing)',
      patch: [{ file: FEATURE, find: " || doc.visibilityState === 'hidden'", replace: '' }],
      run: core('in a hidden tab'),
      expect: /a view transition in a hidden tab/,
    },
    // --- The direction --------------------------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'Back/Forward is always `forward`: `:active-view-transition-type(back)` never matches',
      patch: [{ file: FEATURE, find: "going!.back ? 'back' : 'forward'", replace: "'forward'" }],
      run: core('Back is `back`, Forward `forward`'),
      expect: /Back\/Forward did not animate as `back`\/`forward`/,
    },
    // --- Never two: React's mode -----------------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: "React's mode, and the core starts one too: React's transition skips the core's (two for one page change)",
      patch: [
        {
          file: FEATURE,
          find: '        handed = types;\n        try {\n          return run();\n        } finally {\n          handed = undefined;\n        }',
          replace:
            '        return win.document!.startViewTransition!({\n          update: () => {\n            handed = types;\n            try {\n              return run();\n            } finally {\n              handed = undefined;\n            }\n          },\n          types: [...types],\n        }).updateCallbackDone;',
        },
      ],
      run: react('the page changes in startTransition with its types'),
      expect: /not exactly one view transition, React’s/,
    },
    {
      id: 'G4b',
      title: "React's mode without the types: React's transition runs, `:active-view-transition-type(forward)` never matches",
      patch: [{ file: APP, find: '          transition?.forEach((type) => addTransitionType(type));\n', replace: '' }],
      run: react('the page changes in startTransition with its types'),
      expect: /not exactly one view transition, React’s/,
    },
    // --- The swap: the entry and the scroll once the new page is in ------------------------------------------------------------
    {
      id: 'G5',
      title: 'the core does not wait for the update (updateCallbackDone): the history entry and the scroll go to the old page',
      patch: [{ file: FEATURE, find: '      return started.updateCallbackDone;', replace: '      return Promise.resolve();' }],
      run: core('runs the render in the update'),
      expect: /the history entry or the scroll came before the new page was in/,
    },
    {
      id: 'G6',
      title: 'the history entry is written twice for one page change',
      patch: [{ file: NAVIGATION, find: '      core.history[history](entry(page, key, arrived), page.url + hash);', replace: '      core.history[history](entry(page, key, arrived), page.url + hash);\n      core.history[history](entry(page, key, arrived), page.url + hash);' }],
      run: core('runs the render in the update'),
      expect: /the history entry was written more than once/,
    },
    // --- React: startTransition only with the option, the render's promise after the commit -----------------------------------
    {
      id: 'G7',
      title: "the render's promise resolves before the commit (in a transition, the commit comes later): the page event and the scroll on the old page",
      patch: [{ file: APP, find: '        committed.current.push(done);\n        // A view transition by React', replace: '        done();\n        // A view transition by React' }],
      run: react("the render's promise resolves once the page is committed"),
      expect: /the page event came before the page was committed/,
    },
    {
      id: 'G10',
      title: 'every page change in startTransition, also without the option: a page that suspends keeps the old one (no fallback) in every app',
      patch: [{ file: APP, find: '        (transition ? startTransition : (swap: () => void) => swap())(() => {', replace: '        startTransition(() => {' }],
      run: react('without the option, a page that suspends shows the layout’s fallback at once'),
      expect: /the old page stayed while the new one suspended/,
    },
    // --- Lazy: the feature only when asked for ---------------------------------------------------------------------------------
    {
      id: 'G8',
      title: 'the navigator loads the view transitions with every visit, asked for or not',
      patch: [{ file: NAVIGATION, find: '    if (options.viewTransition ?? core.options.viewTransition) await this.load(loadViewTransitions)', replace: '    if (true as boolean) await this.load(loadViewTransitions)' }],
      run: core('loads its code with the first visit that asks for one'),
      expect: /view transitions loaded without being asked for/,
    },
    {
      id: 'G8b',
      title: 'the view transitions imported statically: in every first download (leak test)',
      patch: [
        {
          file: 'packages/http/dist/client/lazy.js',
          find: "export const loadViewTransitions = () => import('./features/view-transitions.js').then((module) => module.viewTransitions);",
          replace: "import { viewTransitions as staticTransitions } from './features/view-transitions.js';\nexport const loadViewTransitions = () => Promise.resolve(staticTransitions);",
        },
      ],
      run: { vitest: 'packages/react/src/bundle-size.test.ts', name: 'view transitions are a chunk of their own in emptyApp' },
      expect: /view transitions in the first download/,
    },
    // --- CSP: no inline styles -------------------------------------------------------------------------------------------------
    {
      id: 'G9',
      title: 'the shared avatar named by an inline style: the server renders a style attribute — a strict style-src blocks it',
      patch: [
        {
          file: 'apps/web-app/modules/user-profile/views/People.tsx',
          find: 'loading="lazy" className="avatar avatar-small" />',
          replace: 'loading="lazy" className="avatar avatar-small" style={{ viewTransitionName: `avatar-${person.id}` }} />',
        },
      ],
      run: { vitest: 'apps/web-app/modules/user-profile/ssr.test.ts', name: 'without inline styles' },
      expect: /inline styles in the server's markup/,
    },
  ],
});
