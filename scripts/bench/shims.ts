/**
 * `pnpm bench … --without <measures>`: switches the request path's four security measures off in a measured process — and counts
 * how often each one runs, so that "off" is proven, not assumed (`requests.ts` aborts when a measure that is off ran). Preloaded
 * (`--import`) into the worker of the checkout being measured; nothing of this exists outside `pnpm bench`.
 *
 * Each measure is a rewrite of one source file as it loads (a `module.registerHooks` load hook) that routes its code through
 * `globalThis.__marmeonBench.run(measure, original, args)`. An anchor no longer found exactly once stops the process (the code
 * moved: update the anchor here).
 *
 *   session-hash (off: keyed by the plain id) · fetch-metadata (VerifyCsrfToken's stage; off: every unsafe request needs the
 *   token) · csp (off: the worker leaves the middleware out, this file only counts) · epoch (HMAC per page; off: no epoch)
 */
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MEASURES = ['session-hash', 'fetch-metadata', 'csp', 'epoch'] as const;
export type Measure = (typeof MEASURES)[number];

/** `all` is all four. */
export function parseMeasures(values: readonly string[]): Measure[] {
  const measures = new Set<Measure>();
  for (const value of values.flatMap((value) => value.split(',')).filter(Boolean)) {
    if (value === 'all') for (const measure of MEASURES) measures.add(measure);
    else if ((MEASURES as readonly string[]).includes(value)) measures.add(value as Measure);
    else throw new Error(`Unknown measure "${value}" — one of all, ${MEASURES.join(', ')}.`);
  }
  return [...measures];
}

interface Rewrite {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

const BENCH = '(globalThis as any).__marmeonBench';

const REWRITES: Record<Measure, Rewrite> = {
  'session-hash': {
    file: 'packages/session/src/store.ts',
    find: 'export function sessionKey(id: string): string {',
    replace: `export function sessionKey(id: string): string { return ${BENCH}.run('session-hash', __benchSessionKey, [id]); }\nfunction __benchSessionKey(id: string): string {`,
  },
  'fetch-metadata': {
    file: 'packages/session/src/csrf.ts',
    find: 'const from = this.#origin(request);',
    replace: `const from = ${BENCH}.run('fetch-metadata', () => this.#origin(request), []);`,
  },
  csp: {
    file: 'packages/http/src/csp.ts',
    find: 'if (usesNonce) this.#nonce.want();',
    replace: `${BENCH}.run('csp', () => undefined, []);\n      if (usesNonce) this.#nonce.want();`,
  },
  epoch: {
    file: 'packages/http/src/session-epoch.ts',
    find: 'export function epochOf(scope: Pick<Container, \'has\' | \'make\'> | undefined): string | undefined {',
    replace:
      `export function epochOf(scope: Pick<Container, 'has' | 'make'> | undefined): string | undefined { return ${BENCH}.run('epoch', __benchEpochOf, [scope]); }\n` +
      `function __benchEpochOf(scope: Pick<Container, 'has' | 'make'> | undefined): string | undefined {`,
  },
};

/** What the code gives without the measure — returned instead of running it. `csp` is never routed here (see above). */
const BEFORE: Record<Measure, (args: unknown[]) => unknown> = {
  'session-hash': ([id]) => id,
  'fetch-metadata': () => 'unknown',
  csp: () => undefined,
  epoch: () => undefined,
};

export function install(checkout: string, off: readonly Measure[]): void {
  const counters = Object.fromEntries(MEASURES.map((measure) => [measure, 0])) as Record<Measure, number>;
  const disabled = new Set(off);
  (globalThis as { __marmeonBench?: unknown }).__marmeonBench = {
    counters,
    run(measure: Measure, original: (...args: unknown[]) => unknown, args: unknown[]): unknown {
      if (disabled.has(measure) && measure !== 'csp') return BEFORE[measure](args);
      counters[measure]++;
      return original(...args);
    },
  };
  const byUrl = new Map<string, Rewrite & { measure: Measure }>();
  for (const measure of MEASURES) {
    const rewrite = REWRITES[measure];
    byUrl.set(pathToFileURL(join(checkout, rewrite.file)).href, { ...rewrite, measure });
  }
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const rewrite = byUrl.get(url);
      if (!rewrite || result.source === undefined || result.source === null) return result;
      const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source as Uint8Array).toString('utf8');
      const at = source.indexOf(rewrite.find);
      if (at === -1 || source.indexOf(rewrite.find, at + 1) !== -1) {
        throw new Error(`pnpm bench: the anchor of the measure "${rewrite.measure}" is not exactly once in ${rewrite.file} any more — update scripts/bench/shims.ts.`);
      }
      return { ...result, source: source.slice(0, at) + rewrite.replace + source.slice(at + rewrite.find.length) };
    },
  });
}

if (process.env.BENCH_CHECKOUT) install(process.env.BENCH_CHECKOUT, parseMeasures([process.env.BENCH_WITHOUT ?? '']));
