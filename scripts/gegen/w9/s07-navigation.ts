import { defineGegenproben } from '../define.ts';

/**
 * W9.7 — the navigator on the Navigation API (E184, variant "replace"): its own commits and Back/Forward to its own entries only (a
 * plain link, a form, an earlier document stay the browser's), the guard cancelling a Back where the browser lets it and otherwise
 * going back by the browser's key (no counted index), a task between a cancel and Leave, the entry healed when another script erased
 * its state, E36 for the entry's state, tab sync's epoch through the writer's hook (no wrapping), the History fallback only without
 * `window.navigation` (and never in a first download), scroll on Back/Forward, a 409 on both paths, `pageshow(persisted)`, the kit's
 * dialog in German, `useRouter()`'s optimistic patches on first use, `beforeunload` with a guard.
 *
 * Masking pair: the cancel (G1) and the undo by key (G2) are each taken out on their own — each leaves the other's test green (G1c, G2c).
 * The leak cases (G9, G15) patch `dist/` (the size test measures it): run `pnpm build` first. `pageshow(persisted)` is checked here with
 * the fake (G13): the browser case needs a production build, a server and Chrome — run by hand (scratchpad `w9s7b/cdp.mjs bfcache`).
 */
const api = (name: string) => ({ vitest: 'packages/http/src/client/navigation-api.test.ts', name });
const GUARD = 'packages/http/src/client/features/guard.ts';
const NAVIGATION = 'packages/http/src/client/navigation.ts';

const NO_CANCEL = { file: GUARD, find: '    if (event.cancelable) event.preventDefault();', replace: '    if (false as boolean) event.preventDefault();' };
const COUNTED = {
  file: GUARD,
  find: '      const from = navigation.currentEntry!.key;',
  // Where a counted index would say the entry is: the last one (what the old guard assumed after a reload or a session restore).
  replace: '      const from = (navigation as unknown as { entries(): { key: string }[] }).entries().at(-1)!.key;',
};

export default defineGegenproben({
  step: 'W9.7',
  cases: [
    // --- The guard: cancel where the browser lets it, else back by key ------------------------------------------------------
    {
      id: 'G1',
      title: 'a Back right after a click is not cancelled (the old go(-delta) way): the address bar shows the entry left, then comes back',
      patch: [NO_CANCEL],
      run: api('Back right after a click is cancelled'),
      expect: /the Back was not cancelled|the address bar changed/,
      masks: 'G2',
    },
    {
      id: 'G1c',
      title: 'masking probe: without the cancel, a Back without an activation is still undone by key',
      patch: [NO_CANCEL],
      run: api('without an activation (after a session restore)'),
      expectGreen: true,
    },
    {
      id: 'G2',
      title: 'the undo goes to a counted place instead of the browser’s key: after a session restore it lands on another entry',
      patch: [COUNTED],
      run: api('without an activation (after a session restore)'),
      expect: /the guard went back to another entry than the one it left/,
      masks: 'G1',
    },
    {
      id: 'G2c',
      title: 'masking probe: with the counted place, a Back right after a click is still cancelled (no undo needed)',
      patch: [COUNTED],
      run: api('Back right after a click is cancelled'),
      expectGreen: true,
    },
    {
      id: 'G3',
      title: 'Leave traverses in the task that cancelled the Back: the browser refuses it (InvalidStateError) — the user stays',
      patch: [{ file: GUARD, find: '      setTimeout(() => navigation.traverseTo(to));', replace: '      void navigation.traverseTo(to);' }],
      run: api('Back right after a click is cancelled'),
      expect: /Leave did not go|Invalid key/,
    },
    {
      id: 'G4',
      title: 'the guard leaves the user to the History fallback’s undo: without it, Back without a browser API goes unasked',
      patch: [{ file: 'packages/http/src/client/features/history-fallback.ts', find: '        if (blocking.length > 0 && win.history.go) {', replace: '        if (false as boolean) {' }],
      run: { vitest: 'packages/http/src/client/interaction.test.ts', name: 'Back while dirty — the core goes forward again' },
      expect: /Back was not asked about/,
    },
    // --- Only its own navigations ---------------------------------------------------------------------------------------------
    {
      id: 'G5',
      title: 'every push is intercepted, not only the navigator’s own (`info`): a plain link and a GET form never load',
      patch: [{ file: NAVIGATION, find: '    if (navigate.info === OWN) return navigate.intercept(MANUAL);', replace: "    if (navigate.info === OWN || navigate.navigationType === 'push') return navigate.intercept(MANUAL);" }],
      run: api('a plain link, a plain GET form and another site stay the browser’s'),
      expect: /the navigator intercepted a navigation that is not its own/,
    },
    {
      id: 'G6',
      title: 'Back to an earlier document’s entry (canIntercept false) is tried anyway — the browser refuses it with a SecurityError',
      patch: [{ file: NAVIGATION, find: " || !navigate.canIntercept || core.left || !isHistoryState(state)", replace: ' || core.left || !isHistoryState(state)' }],
      run: api('Back to an entry of an earlier document'),
      expect: /the navigator tried to intercept what it cannot/,
    },
    // --- What an entry holds (E36) and who writes it -----------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'the writer keeps what it does not know and the entry brings the props: the Navigation API’s state holds the token',
      patch: [
        { file: 'packages/http/src/client/history.ts', find: '      if (this.#fields.get(name)?.(value)) kept[name] = value;', replace: '      if (true as boolean) kept[name] = value;' },
        {
          file: 'packages/http/src/client/history.ts',
          find: '  return withPosition({ component: page.component, url: page.url, key, scroll: position.scroll }, position);',
          replace: '  return withPosition({ component: page.component, url: page.url, key, scroll: position.scroll, props: page.props } as HistoryState, position);',
        },
      ],
      run: { vitest: 'packages/http/src/client/navigation.test.ts', name: 'keeps only { component, url, scroll, key } in the entry’s state' },
      expect: /props in a history entry/,
    },
    {
      id: 'G8',
      title: 'the writer without its hook for a feature’s field: tab sync’s epoch is in no entry (nothing wraps the writer any more)',
      patch: [{ file: 'packages/http/src/client/history.ts', find: '    for (const [name, value] of this.#values) all[name] = value(state);\n', replace: '' }],
      run: api('every entry holds the epoch it was written under'),
      expect: /an entry without its epoch/,
    },
    {
      id: 'G9',
      title: 'an entry another script’s replaceState erased is not written again when it is left: Forward finds nothing to follow',
      patch: [{ file: NAVIGATION, find: '    if (!core.transitioning) this.#save();\n', replace: '' }],
      run: api('heals an entry another script’s'),
      expect: /the entry left was not written again|Forward found the erased entry and followed nothing/,
    },
    {
      id: 'G10',
      title: 'Back/Forward without restoring the scroll position',
      patch: [{ file: NAVIGATION, find: '      core.scroll.apply(position);\n      core.props.load();', replace: '      core.props.load();' }],
      run: api('follows Back/Forward to its own entries from memory'),
      expect: /the scroll position was not restored/,
    },
    // --- The History fallback: only without window.navigation, never in a first download ------------------------------------
    {
      id: 'G11',
      title: 'createMarmeonApp does not detect a browser without the Navigation API: no fallback, nothing follows Back/Forward',
      patch: [{ file: 'packages/react/src/client.tsx', find: '    window.navigation ? undefined : loadHistoryFallback(),', replace: '    undefined,' }],
      run: { vitest: 'packages/react/src/client.test.tsx', name: 'loads it beside the first page where the browser has no Navigation API' },
      expect: /no History fallback attached/,
    },
    {
      id: 'G12',
      title: 'the History fallback imported statically: it is in every first download (leak test)',
      patch: [
        {
          file: 'packages/http/dist/client/lazy.js',
          find: "export const loadHistoryFallback = () => import('./features/history-fallback.js').then((module) => module.historyFallback);",
          replace: "import { historyFallback as staticFallback } from './features/history-fallback.js';\nexport const loadHistoryFallback = () => Promise.resolve(staticFallback);",
        },
      ],
      run: { vitest: 'packages/react/src/bundle-size.test.ts', name: 'the History fallback is a chunk of its own in emptyApp' },
      expect: /not include 'history'/,
    },
    // --- A 409 on both paths (the security matrix, once per path) -------------------------------------------------------------
    {
      id: 'G13',
      title: 'a 409 (signed out) does not change the document — on the Navigation API’s path and the History fallback’s',
      patch: [{ file: NAVIGATION, find: '    if (response.status === 409 && response.headers.has(LOCATION_HEADER)) {\n      // A new build', replace: '    if (false as boolean) {\n      // A new build' }],
      run: { vitest: 'packages/http/src/client/security-matrix.test.ts', name: 'a 409 (signed out) leaves nothing of it' },
      expect: /assign \/login/,
    },
    // --- Tab sync: the bfcache, the kit's dialog -------------------------------------------------------------------------------
    {
      id: 'G14',
      title: 'back from the back/forward cache (pageshow persisted), the tab does not ask the server for the epoch',
      patch: [{ file: 'packages/http/src/client/features/tab-sync.ts', find: '      if ((event as PageTransitionEvent).persisted && !host.left) void check(\'server\');', replace: '      void event;' }],
      run: { vitest: 'packages/http/src/client/features/tab-sync.test.ts', name: 'back from the back/forward cache: it asks the server' },
      expect: /to deeply equal \[ 1, \[ 'reload' \] \]/,
    },
    {
      id: 'G15',
      title: 'the starter kit’s dialog asks the session question in English: the German page shows the framework’s text',
      patch: [{ file: 'packages/create-marmeon/template/kit/bootstrap/confirm.tsx', find: "      request={session ? { ...props.request, message: t('confirm.session') } : props.request}", replace: '      request={props.request}' }],
      run: { vitest: 'packages/create-marmeon/src/create.test.ts', name: 'the starter kit works', timeout: 15 * 60_000 },
      expect: /the kit's tests failed:[\s\S]*confirm\.test\.ts/,
    },
    // --- useRouter(): the page's patches on first use; the guard's beforeunload ------------------------------------------------
    {
      id: 'G16',
      title: 'useRouter() imports the page’s optimistic patches statically again: they are in every first download of an app with a router',
      patch: [
        {
          file: 'packages/react/dist/app.js',
          find: '    return loaded ? loaded.target(key) : laterTarget(navigator.load(loadOptimistic).then((feature) => feature.target(key)));',
          replace: '    return navigator.use(optimisticFeature).target(key);',
        },
        { file: 'packages/react/dist/app.js', find: 'laterTarget, loadOptimistic,', replace: 'laterTarget, loadOptimistic, optimistic as optimisticFeature,' },
      ],
      run: { vitest: 'packages/react/src/bundle-size.test.ts', name: 'the page’s optimistic patches are a chunk of their own in everything' },
      expect: /not include 'optimistic'/,
    },
    {
      id: 'G17',
      title: 'a guard without the browser’s own question: closing the tab or reloading loses the unsaved changes unasked',
      patch: [{ file: GUARD, find: "    if (this.#guards.size === 1 && this.#core.started) window.addEventListener('beforeunload', this.#onBeforeUnload);", replace: '    void window;' }],
      run: api('closing the tab or reloading with a guard'),
      expect: /no beforeunload listener while guarded/,
    },
  ],
});
