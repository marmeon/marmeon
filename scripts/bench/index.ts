/**
 * `pnpm bench <scenario> [options]` — measurements kept in the repository (E166), never a gate: no part of `pnpm run ci`.
 *
 *   pnpm bench boot --app apps/web-app            # bespoke start → GET /up 200: median of 7 and a breakdown (W8 step 3)
 *
 * Wave 8 step 9 adds the request-path scenarios (`login`, `people`) and `--base <ref>` (a `git worktree`, A/B alternating).
 */
const scenarios: Record<string, () => Promise<{ main(args: string[]): Promise<number> }>> = {
  boot: () => import('./boot.ts'),
};

const [name, ...args] = process.argv.slice(2);
const scenario = name === undefined ? undefined : scenarios[name];
if (!scenario) {
  process.stderr.write(`Usage: pnpm bench <scenario> [options] — scenarios: ${Object.keys(scenarios).join(', ')}\n`);
  process.exitCode = 2;
} else {
  process.exitCode = await (await scenario()).main(args);
}
