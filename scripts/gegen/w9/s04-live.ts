import { defineGegenproben } from '../define.ts';

/**
 * W9.4 — the live hints (SSE) hardened (E182, E191): a limit per session (429) and atomic counts, the channel index, the server's
 * closing refuses new streams, the stream's path read-only by itself, the memory backend's sequences bounded, the boot error for
 * memory + `--workers`, keep-alive above nginx's, live paused while the tab-sync question is open, `liveValidation` in the security
 * matrix, and listeners that go with the navigator. Masking pair: the session limit ↔ the atomic count (each its own case and probe).
 */
const hub = (name: string) => ({ vitest: 'packages/live/src/live.test.ts', name });
const client = (name: string) => ({ vitest: 'packages/http/src/client/live.test.ts', name });
const HUB = 'packages/live/src/hub.ts';
const SESSION_LIMIT = { file: HUB, find: '    if ((this.#sessions.get(request.scope)?.size ?? 0) >= this.#perSession) {', replace: '    if (false) {' };
/** The stream takes its place after the first `await` — check, then act. */
const CHECK_THEN_ACT = [
  {
    file: HUB,
    find: `    this.#streams.add(stream);
    index(this.#sessions, stream.scope, stream);
    for (const channel of stream.channels) index(this.#channels, channel, stream);
    try {
      await this.#listen();
`,
    replace: `    try {
      await this.#listen();
      this.#streams.add(stream);
      index(this.#sessions, stream.scope, stream);
      for (const channel of stream.channels) index(this.#channels, channel, stream);
`,
  },
];
const NO_CLOSING_FLAG = { file: HUB, find: '      this.#closed = true;\n      this.closeStreams();\n    };', replace: '      this.closeStreams();\n    };' };
const LIVE = 'packages/http/src/client/features/live.ts';
const TAB_SYNC = 'packages/http/src/client/features/tab-sync.ts';

export default defineGegenproben({
  step: 'W9.4',
  cases: [
    // --- Limits -------------------------------------------------------------------------------------------------------------
    {
      id: 'G1',
      title: 'no limit per session: the 17th stream of one session opens (200 instead of 429)',
      patch: [SESSION_LIMIT],
      run: hub('holds at most LIVE_MAX_STREAMS_PER_SESSION streams of one session'),
      expect: /expected 200 to be 429/,
      masks: 'G2',
    },
    {
      id: 'G1b',
      title: 'the same in the web app: Ada’s 17th tab connects',
      patch: [SESSION_LIMIT],
      run: { vitest: 'apps/web-app/modules/user-profile/live.test.ts', name: 'one browser keeps 16 tabs connected' },
      expect: /expected 200 to be 429/,
    },
    {
      id: 'G1c',
      title: 'masking probe: without the session limit, the process limit still holds (its own count)',
      patch: [SESSION_LIMIT],
      run: hub('holds at most LIVE_MAX_STREAMS streams per process'),
      expectGreen: true,
    },
    {
      id: 'G2',
      title: 'check-then-act: fifty streams opening at once get past the limits (the place taken after the await)',
      patch: CHECK_THEN_ACT,
      run: hub('counts atomically'),
      expect: /expected \{ opened: 50/,
      masks: 'G1',
    },
    {
      id: 'G2c',
      title: 'masking probe: with check-then-act, one session opening its tabs one after the other still meets its limit',
      patch: CHECK_THEN_ACT,
      run: hub('holds at most LIVE_MAX_STREAMS_PER_SESSION streams of one session'),
      expectGreen: true,
    },
    // --- The index ----------------------------------------------------------------------------------------------------------
    {
      id: 'G3',
      title: 'no channel index: a hint walks every stream of the process (32 deliveries for 2 followers)',
      patch: [
        {
          file: HUB,
          find: "    const streams = message.kind === 'end' ? this.#sessions.get(message.scope) : this.#channels.get(message.channel);",
          replace: "    const streams = message.kind === 'end' ? new Set([...this.#streams].filter((stream) => stream.scope === message.scope)) : this.#streams;",
        },
      ],
      run: hub('a hint goes to the streams of its channel only'),
      expect: /to be called 2 times, but got 32 times/,
    },
    // --- The server closing -------------------------------------------------------------------------------------------------
    {
      id: 'G4',
      title: 'the closing server does not refuse: a stream asked for after close() began opens (200)',
      patch: [NO_CLOSING_FLAG],
      run: hub('the server began closing: a stream asked for afterwards is refused'),
      expect: /expected \[ 200, null/,
    },
    {
      id: 'G4b',
      title: 'the old code (no closing flag, the place taken after the await): a stream on its way holds server.close() until the hard exit',
      patch: [NO_CLOSING_FLAG, ...CHECK_THEN_ACT],
      run: { vitest: 'packages/live/src/server.test.ts', name: 'a stream opened while the server drains' },
      expect: /expected 'held' to be 'closed'/,
    },
    // --- Read-only at the path ----------------------------------------------------------------------------------------------
    {
      id: 'G5',
      title: 'read-only only by the Accept header: GET /_bespoke/live without it writes the session’s cookies',
      patch: [
        {
          file: 'packages/server/src/kernel.ts',
          find: "    const stream = pathname === LIVE_PATH || request.headers.get('accept')?.includes('text/event-stream') === true;",
          replace: "    const stream = request.headers.get('accept')?.includes('text/event-stream') === true;",
        },
      ],
      run: { vitest: 'packages/live/src/guests.test.ts', name: "the stream's path is read-only by itself" },
      expect: /to deeply equal \[\]/,
    },
    // --- The memory backend -------------------------------------------------------------------------------------------------
    {
      id: 'G6',
      title: 'the memory backend’s sequences grow without bound: nothing is forgotten (no LRU, no TTL)',
      patch: [
        { file: 'packages/live/src/backend.ts', find: '    this.#expire(now);\n    const seq', replace: '    const seq' },
        { file: 'packages/live/src/backend.ts', find: '      if (this.#seqs.size <= this.#max) break;', replace: '      break;' },
        { file: 'packages/live/src/backend.ts', find: '    this.#expire(this.#now());\n    return channels.map', replace: '    return channels.map' },
      ],
      run: hub('forgets the channel hinted longest ago beyond maxChannels'),
      expect: /expected \[ 2, 1, 1, 1 \]/,
    },
    {
      id: 'G6b',
      title: 'a forgotten channel starts again at 1: an open stream that saw 5 drops the next hints',
      patch: [{ file: 'packages/live/src/backend.ts', find: '?? this.#floor) + 1;', replace: '?? 0) + 1;' }],
      run: hub('a forgotten channel counts on above every forgotten sequence'),
      expect: /expected 1 to be 6/,
    },
    {
      id: 'G6c',
      title: 'a counter that started again (expired, evicted, flushed): the open stream drops its hints as "old" — live goes silent',
      patch: [{ file: HUB, find: '    // evicted or flushed; the memory backend forgot it) — told, never dropped as "old" (W9 step 4).\n', replace: '    // evicted or flushed; the memory backend forgot it) — told, never dropped as "old" (W9 step 4).\n    if (message.seq <= (this.#seqs.get(message.channel) ?? 0)) return;\n' }],
      run: hub('an open stream that saw 5 is told the hints of the new count'),
      expect: /The live stream did not get 7 hints/,
    },
    {
      id: 'G6d',
      title: 'the same against Redis: the sequence key deleted (its TTL), the stream hears nothing more',
      patch: [{ file: HUB, find: '    // evicted or flushed; the memory backend forgot it) — told, never dropped as "old" (W9 step 4).\n', replace: '    // evicted or flushed; the memory backend forgot it) — told, never dropped as "old" (W9 step 4).\n    if (message.seq <= (this.#seqs.get(message.channel) ?? 0)) return;\n' }],
      run: { vitest: 'packages/live/src/live.test.ts', name: 'the sequence key expired (a day without hints) or was deleted', env: { BESPOKE_TEST_REDIS_URL: 'redis://127.0.0.1:56379' } },
      expect: /The live stream did not get 4 hints/,
    },
    {
      id: 'G6e',
      title: 'without the filter on the hints that came while hello was prepared: one it counted is told again',
      patch: [{ file: HUB, find: '    for (const message of waiting) if (message.seq > (this.#seqs.get(message.channel) ?? 0)) this.hint(message);', replace: '    for (const message of waiting) this.hint(message);' }],
      run: hub('a hint that arrives while hello is prepared goes out right after it'),
      expect: /expected \[ 1, 2 \] to deeply equal \[ 2 \]/,
    },
    // --- memory + --workers -------------------------------------------------------------------------------------------------
    {
      id: 'G7',
      title: 'no boot error: a worker of a cluster starts with LIVE_DRIVER=memory',
      patch: [{ file: 'packages/live/src/index.ts', find: "    if (config.driver === 'memory' && process.env[CLUSTER_WORKER] === '1' && cluster.isWorker) {", replace: '    if (false) {' }],
      run: { vitest: 'packages/live/src/server.test.ts', name: 'a worker of a cluster does not start with LIVE_DRIVER=memory' },
      expect: /output: 'booted'/,
    },
    {
      id: 'G7b',
      title: 'the mark alone decides: a single process with BESPOKE_CLUSTER_WORKER left in its environment refuses to start',
      patch: [{ file: 'packages/live/src/index.ts', find: " && process.env[CLUSTER_WORKER] === '1' && cluster.isWorker) {", replace: " && process.env[CLUSTER_WORKER] === '1') {" }],
      run: { vitest: 'packages/live/src/server.test.ts', name: 'one process starts with it' },
      expect: /code: 70/,
    },
    {
      id: 'G7c',
      title: 'a worker whose app fails to boot hangs on its channel to the primary — the cluster never ends',
      patch: [
        {
          file: 'packages/cli/bin/bespoke.js',
          find: "  if (process.exitCode !== 0 && process.env.BESPOKE_CLUSTER_WORKER === '1' && process.connected) {",
          replace: '  if (false) {',
        },
      ],
      run: { vitest: 'packages/cli/src/cli.test.ts', name: 'a worker that cannot start stops the cluster with its exit code' },
      expect: /ended before it listened/,
    },
    // --- Keep-alive ---------------------------------------------------------------------------------------------------------
    {
      id: 'G8',
      title: 'Node’s keep-alive defaults: idle connections close after 5 s — before nginx’s 60 s',
      patch: [
        {
          file: 'packages/server/src/kernel.ts',
          find: '  const server = createServer({ keepAliveTimeout: keepAliveTimeoutMs, headersTimeout: Math.min(300_000, Math.max(60_000, keepAliveTimeoutMs + 1000)) });',
          replace: '  const server = createServer();',
        },
      ],
      run: { vitest: 'packages/server/src/production-http.test.ts', name: 'keeps idle connections 65 s' },
      expect: /expected \[ 5000, 60000/,
    },
    {
      id: 'G8b',
      title: 'the nginx template keeps idle upstream connections longer than the app (75 s)',
      patch: [{ file: 'packages/cli/src/docker.ts', find: '\tkeepalive_timeout 60s;', replace: '\tkeepalive_timeout 75s;' }],
      run: { vitest: 'packages/cli/src/make-docker.test.ts', name: 'Caddy in front (h2/h3, TLS)' },
      expect: /expected 65000 to be greater than 75000/,
    },
    // --- Paused while the tab-sync question is open ----------------------------------------------------------------------------
    {
      id: 'G9',
      title: 'tab sync does not tell: the live stream stays open while the question is open',
      patch: [{ file: TAB_SYNC, find: "      host.fire('stale', true);\n", replace: '' }],
      run: client('pauses while the tab-sync question is open'),
      expect: /expected false to be true/,
    },
    {
      id: 'G9b',
      title: 'live does not listen: the stream stays open while the question is open',
      patch: [{ file: LIVE, find: '    now.paused = stale || undefined;', replace: '    now.paused = undefined;' }],
      run: client('pauses while the tab-sync question is open'),
      expect: /expected false to be true/,
    },
    {
      id: 'G9c',
      title: 'paused, but what waits reloads under the new session (apply)',
      patch: [{ file: LIVE, find: '    if (host.left || now.paused || (!now.hinted?.size && !now.missed?.size)) return;', replace: '    if (host.left || (!now.hinted?.size && !now.missed?.size)) return;' }],
      run: client('pauses while the tab-sync question is open'),
      expect: /expected \[ '\/users\/1 profile' \]/,
    },
    // --- The matrix and the listeners ---------------------------------------------------------------------------------------
    {
      id: 'G10',
      title: 'liveValidation left out of the security matrix',
      patch: [{ file: 'packages/http/src/client/security-matrix.test.ts', find: 'live, liveValidation, hooks', replace: 'live, hooks' }],
      run: { vitest: 'packages/http/src/client/security-matrix.test.ts', name: 'holds every feature module of the core to its rules' },
      expect: /not in ALL_FEATURES: liveValidation/,
    },
    {
      id: 'G11',
      title: 'live runs without a started navigator: the thrown-away navigator listens to the document (and throws on visibilitychange)',
      patch: [
        { file: LIVE, find: '    if (host.left || !host.started || !win.EventSource) return;', replace: '    if (host.left || !win.EventSource) return;' },
        { file: LIVE, find: '  if (host.started) listen();', replace: '  listen();' },
      ],
      run: client('a second navigator (React builds one after a hydration mismatch)'),
      expect: /expected \[ 3, 2, 4 \]/,
    },
    {
      id: 'G11b',
      title: 'tab sync keeps its visibilitychange listener after stop()',
      patch: [{ file: TAB_SYNC, find: "      doc?.removeEventListener?.('visibilitychange', onVisible);\n", replace: '' }],
      run: client('a second navigator (React builds one after a hydration mismatch)'),
      expect: /expected \[ 1, \+0, \+0 \]/,
    },
    {
      id: 'G11c',
      title: 'live keeps its document and window listeners after stop()',
      patch: [
        {
          file: LIVE,
          find: "    doc?.removeEventListener?.('visibilitychange', back);\n    doc?.removeEventListener?.('resume', back);\n    win.removeEventListener('pageshow', back);\n",
          replace: '',
        },
      ],
      run: client('a second navigator (React builds one after a hydration mismatch)'),
      expect: /expected \[ 1, 1, 1 \]/,
    },
  ],
});
