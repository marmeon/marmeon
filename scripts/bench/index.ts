/**
 * `pnpm bench <scenario> [options]` — measurements kept in the repository (E166), never a gate: no part of `pnpm run ci`.
 *
 *   pnpm bench boot --app apps/web-app                 # bespoke start → GET /up 200: median of 7 and a breakdown (W8 step 3)
 *   pnpm bench login --base f785159 --without w8       # the request path: /login A/B against a base, Wave 8's measures off (W8 step 9)
 *   pnpm bench people                                  # GET /people signed in
 *   pnpm bench login --profile --base f785159          # CPU profiles of the measured requests, top lists and their diff
 *   pnpm bench fanout [--streams 50000]                # one live hint among N open streams: the channel index (W9 step 4)
 *
 * See `boot.ts` and `requests.ts` for every option.
 */
const scenarios: Record<string, (args: string[]) => Promise<number>> = {
  boot: async (args) => (await import('./boot.ts')).main(args),
  login: async (args) => (await import('./requests.ts')).main('login', args),
  people: async (args) => (await import('./requests.ts')).main('people', args),
  fanout: async (args) => (await import('./fanout.ts')).main(args),
};

const [name, ...args] = process.argv.slice(2);
const scenario = name === undefined ? undefined : scenarios[name];
if (!scenario) {
  process.stderr.write(`Usage: pnpm bench <scenario> [options] — scenarios: ${Object.keys(scenarios).join(', ')}\n`);
  process.exitCode = 2;
} else {
  process.exitCode = await scenario(args);
}
